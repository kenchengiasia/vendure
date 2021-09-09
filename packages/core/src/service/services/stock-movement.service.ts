import { Injectable } from '@nestjs/common';
import { GlobalFlag, StockMovementListOptions } from '@vendure/common/lib/generated-types';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';

import { RequestContext } from '../../api/common/request-context';
import { EntityNotFoundError, InternalServerError } from '../../common/error/errors';
import { ShippingCalculator } from '../../config/shipping-method/shipping-calculator';
import { ShippingEligibilityChecker } from '../../config/shipping-method/shipping-eligibility-checker';
import { OrderItem } from '../../entity/order-item/order-item.entity';
import { OrderLine } from '../../entity/order-line/order-line.entity';
import { Order } from '../../entity/order/order.entity';
import { ProductVariant } from '../../entity/product-variant/product-variant.entity';
import { ShippingMethod } from '../../entity/shipping-method/shipping-method.entity';
import { Allocation } from '../../entity/stock-movement/allocation.entity';
import { Cancellation } from '../../entity/stock-movement/cancellation.entity';
import { Release } from '../../entity/stock-movement/release.entity';
import { Sale } from '../../entity/stock-movement/sale.entity';
import { StockAdjustment } from '../../entity/stock-movement/stock-adjustment.entity';
import { StockMovement } from '../../entity/stock-movement/stock-movement.entity';
import { EventBus } from '../../event-bus/event-bus';
import { StockMovementEvent } from '../../event-bus/events/stock-movement-event';
import { ListQueryBuilder } from '../helpers/list-query-builder/list-query-builder';
import { TransactionalConnection } from '../transaction/transactional-connection';

import { GlobalSettingsService } from './global-settings.service';
@Injectable()
export class StockMovementService {
    shippingEligibilityCheckers: ShippingEligibilityChecker[];
    shippingCalculators: ShippingCalculator[];
    private activeShippingMethods: ShippingMethod[];

    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private globalSettingsService: GlobalSettingsService,
        private eventBus: EventBus,
    ) {}

    getStockMovementsByProductVariantId(
        ctx: RequestContext,
        productVariantId: ID,
        options: StockMovementListOptions,
    ): Promise<PaginatedList<StockMovement>> {
        return this.listQueryBuilder
            .build<StockMovement>(StockMovement as any, options, { ctx })
            .leftJoin('stockmovement.productVariant', 'productVariant')
            .andWhere('productVariant.id = :productVariantId', { productVariantId })
            .getManyAndCount()
            .then(async ([items, totalItems]) => {
                return {
                    items,
                    totalItems,
                };
            });
    }

    async adjustProductVariantStock(
        ctx: RequestContext,
        productVariantId: ID,
        oldStockLevel: number,
        newStockLevel: number,
    ): Promise<StockAdjustment | undefined> {
        if (oldStockLevel === newStockLevel) {
            return;
        }
        const delta = newStockLevel - oldStockLevel;

        const adjustment = await this.connection.getRepository(ctx, StockAdjustment).save(
            new StockAdjustment({
                quantity: delta,
                productVariant: { id: productVariantId },
            }),
        );
        this.eventBus.publish(new StockMovementEvent(ctx, [adjustment]));
        return adjustment;
    }

    async createAllocationsForOrder(ctx: RequestContext, order: Order): Promise<Allocation[]> {
        if (order.active !== false) {
            throw new InternalServerError('error.cannot-create-allocations-for-active-order');
        }
        const allocations: Allocation[] = [];
        const globalTrackInventory = (await this.globalSettingsService.getSettings(ctx)).trackInventory;
        for (const line of order.lines) {
            const { productVariant } = line;
            const allocation = new Allocation({
                productVariant,
                quantity: line.quantity,
                orderLine: line,
            });
            allocations.push(allocation);

            if (this.trackInventoryForVariant(productVariant, globalTrackInventory)) {
                productVariant.stockAllocated += line.quantity;
                const holdStock = ctx?.channel?.customFields
                    ? Object.entries(ctx.channel.customFields)
                          .filter(a => a[0] === 'holdStock')
                          .map(a => a[1])[0]
                    : false;

                if (holdStock) {
                    const stockOnHold = productVariant?.customFields
                        ? Object.entries(productVariant.customFields)
                              .filter(a => a[0] === 'stockOnHold')
                              .map(a => a[1])[0]
                        : 0;
                    let localStockOnHold;
                    if (line.quantity > stockOnHold) {
                        localStockOnHold = 0;
                    } else {
                        localStockOnHold = stockOnHold - line.quantity;
                    }
                    productVariant.customFields = {
                        ...productVariant.customFields,
                        stockOnHold: localStockOnHold,
                    };
                }

                await this.connection
                    .getRepository(ctx, ProductVariant)
                    .save(productVariant, { reload: false });
            }
        }
        const savedAllocations = await this.connection.getRepository(ctx, Allocation).save(allocations);
        if (savedAllocations.length) {
            this.eventBus.publish(new StockMovementEvent(ctx, savedAllocations));
        }
        return savedAllocations;
    }

    /**
     * @description
     * Returns the number of saleable units of the ProductVariant, i.e. how many are available
     * for purchase by Customers.
     */
    async getSaleableStockLevel(ctx: RequestContext, variant: ProductVariant): Promise<number> {
        // TODO: Use caching (RequestContextCacheService) to reduce DB calls
        const { outOfStockThreshold, trackInventory } = await this.globalSettingsService.getSettings(ctx);
        const inventoryNotTracked =
            variant.trackInventory === GlobalFlag.FALSE ||
            (variant.trackInventory === GlobalFlag.INHERIT && trackInventory === false);
        if (inventoryNotTracked) {
            return Number.MAX_SAFE_INTEGER;
        }

        const effectiveOutOfStockThreshold = variant.useGlobalOutOfStockThreshold
            ? outOfStockThreshold
            : variant.outOfStockThreshold;

        const holdStock = ctx?.channel?.customFields
            ? Object.entries(ctx.channel.customFields)
                  .filter(a => a[0] === 'holdStock')
                  .map(a => a[1])[0]
            : false;
        if (holdStock) {
            const stockOnHold = variant?.customFields
                ? Object.entries(variant.customFields)
                      .filter(a => a[0] === 'stockOnHold')
                      .map(a => a[1])[0]
                : 0;
            return variant.stockOnHand - stockOnHold - variant.stockAllocated - effectiveOutOfStockThreshold;
        } else {
            return variant.stockOnHand - variant.stockAllocated - effectiveOutOfStockThreshold;
        }
    }

    async getProductVariantForUpdate(ctx: RequestContext, id: ID): Promise<ProductVariant> {
        const variant = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('productvariant')
            .setLock('pessimistic_write')
            .where('productvariant.id = :id', { id })
            .getOne();
        if (!variant) {
            throw new EntityNotFoundError('ProductVariant', id);
        }
        return variant;
    }

    async holdStock(ctx: RequestContext, id: ID, holdQty: number): Promise<number> {
        const { trackInventory } = await this.globalSettingsService.getSettings(ctx);
        const variant = await this.getProductVariantForUpdate(ctx, id);

        const inventoryNotTracked =
            variant.trackInventory === GlobalFlag.FALSE ||
            (variant.trackInventory === GlobalFlag.INHERIT && trackInventory === false);
        if (inventoryNotTracked) return holdQty;

        const existingValue = variant?.customFields
            ? Object.entries(variant.customFields)
                  .filter(a => a[0] === 'stockOnHold')
                  .map(a => a[1])[0]
            : 0;

        if (holdQty !== 0) {
            variant.customFields = { stockOnHold: existingValue + holdQty };
            await this.connection.getRepository(ctx, ProductVariant).save(variant, { reload: true });
        }
        return holdQty;
    }

    async releaseStock(ctx: RequestContext, id: ID, releasedQty: number): Promise<number> {
        const { trackInventory } = await this.globalSettingsService.getSettings(ctx);

        const variant = await this.getProductVariantForUpdate(ctx, id);
        const inventoryNotTracked =
            variant.trackInventory === GlobalFlag.FALSE ||
            (variant.trackInventory === GlobalFlag.INHERIT && trackInventory === false);
        if (inventoryNotTracked) return releasedQty;

        const currentStockOnHold = variant?.customFields
            ? Object.entries(variant.customFields)
                  .filter(a => a[0] === 'stockOnHold')
                  .map(a => a[1])[0]
            : 0;
        if (releasedQty > currentStockOnHold) {
            variant.customFields = { stockOnHold: 0 };
        } else {
            variant.customFields = { stockOnHold: currentStockOnHold - releasedQty };
        }
        await this.connection.getRepository(ctx, ProductVariant).save(variant, { reload: true });
        return releasedQty;
    }

    async createSalesForOrder(ctx: RequestContext, orderItems: OrderItem[]): Promise<Sale[]> {
        const sales: Sale[] = [];
        const globalTrackInventory = (await this.globalSettingsService.getSettings(ctx)).trackInventory;
        const orderItemsWithVariants = await this.connection.getRepository(ctx, OrderItem).findByIds(
            orderItems.map(i => i.id),
            {
                relations: ['line', 'line.productVariant'],
            },
        );
        const orderLinesMap = new Map<ID, { line: OrderLine; items: OrderItem[] }>();

        for (const orderItem of orderItemsWithVariants) {
            let value = orderLinesMap.get(orderItem.line.id);
            if (!value) {
                value = { line: orderItem.line, items: [] };
                orderLinesMap.set(orderItem.line.id, value);
            }
            value.items.push(orderItem);
        }
        for (const lineRow of orderLinesMap.values()) {
            const { productVariant } = lineRow.line;
            const sale = new Sale({
                productVariant,
                quantity: lineRow.items.length * -1,
                orderLine: lineRow.line,
            });
            sales.push(sale);

            if (this.trackInventoryForVariant(productVariant, globalTrackInventory)) {
                productVariant.stockOnHand -= lineRow.items.length;
                if (lineRow.items.length > productVariant.stockAllocated) {
                    productVariant.stockAllocated = 0;
                } else {
                    productVariant.stockAllocated -= lineRow.items.length;
                }
                await this.connection
                    .getRepository(ctx, ProductVariant)
                    .save(productVariant, { reload: false });
            }
        }
        const savedSales = await this.connection.getRepository(ctx, Sale).save(sales);
        if (savedSales.length) {
            this.eventBus.publish(new StockMovementEvent(ctx, savedSales));
        }
        return savedSales;
    }

    async createCancellationsForOrderItems(ctx: RequestContext, items: OrderItem[]): Promise<Cancellation[]> {
        const orderItems = await this.connection.getRepository(ctx, OrderItem).findByIds(
            items.map(i => i.id),
            {
                relations: ['line', 'line.productVariant'],
            },
        );
        const cancellations: Cancellation[] = [];
        const globalTrackInventory = (await this.globalSettingsService.getSettings(ctx)).trackInventory;
        const variantsMap = new Map<ID, ProductVariant>();
        for (const item of orderItems) {
            let productVariant: ProductVariant;
            const productVariantId = item.line.productVariant.id;
            if (variantsMap.has(productVariantId)) {
                // tslint:disable-next-line:no-non-null-assertion
                productVariant = variantsMap.get(productVariantId)!;
            } else {
                productVariant = item.line.productVariant;
                variantsMap.set(productVariantId, productVariant);
            }
            const cancellation = new Cancellation({
                productVariant,
                quantity: 1,
                orderItem: item,
            });
            cancellations.push(cancellation);

            if (this.trackInventoryForVariant(productVariant, globalTrackInventory)) {
                productVariant.stockOnHand += 1;
                await this.connection
                    .getRepository(ctx, ProductVariant)
                    .save(productVariant, { reload: false });
            }
        }
        const savedCancellations = await this.connection.getRepository(ctx, Cancellation).save(cancellations);
        if (savedCancellations.length) {
            this.eventBus.publish(new StockMovementEvent(ctx, savedCancellations));
        }
        return savedCancellations;
    }

    async createReleasesForOrderItems(ctx: RequestContext, items: OrderItem[]): Promise<Release[]> {
        const orderItems = await this.connection.getRepository(ctx, OrderItem).findByIds(
            items.map(i => i.id),
            {
                relations: ['line', 'line.productVariant'],
            },
        );
        const releases: Release[] = [];
        const globalTrackInventory = (await this.globalSettingsService.getSettings(ctx)).trackInventory;
        const variantsMap = new Map<ID, ProductVariant>();
        for (const item of orderItems) {
            let productVariant: ProductVariant;
            const productVariantId = item.line.productVariant.id;
            if (variantsMap.has(productVariantId)) {
                // tslint:disable-next-line:no-non-null-assertion
                productVariant = variantsMap.get(productVariantId)!;
            } else {
                productVariant = item.line.productVariant;
                variantsMap.set(productVariantId, productVariant);
            }
            const release = new Release({
                productVariant,
                quantity: 1,
                orderItem: item,
            });
            releases.push(release);

            if (this.trackInventoryForVariant(productVariant, globalTrackInventory)) {
                productVariant.stockAllocated -= 1;
                await this.connection
                    .getRepository(ctx, ProductVariant)
                    .save(productVariant, { reload: false });
            }
        }
        const savedReleases = await this.connection.getRepository(ctx, Release).save(releases);
        if (savedReleases.length) {
            this.eventBus.publish(new StockMovementEvent(ctx, savedReleases));
        }
        return savedReleases;
    }

    private trackInventoryForVariant(variant: ProductVariant, globalTrackInventory: boolean): boolean {
        return (
            variant.trackInventory === GlobalFlag.TRUE ||
            (variant.trackInventory === GlobalFlag.INHERIT && globalTrackInventory)
        );
    }
}
