import '@shopify/ui-extensions';

// @ts-expect-error Required by Shopify extension typings
declare module './src/ActionExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

// @ts-expect-error Required by Shopify extension typings
declare module './src/config.js' {
  const shopify: import('@shopify/ui-extensions/admin.product-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
