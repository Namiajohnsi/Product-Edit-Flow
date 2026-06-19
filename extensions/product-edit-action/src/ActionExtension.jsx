// @ts-nocheck
import { APP_HANDLE } from "./config.js";

export default async function() {
  try {
    const productId = shopify.data?.selected?.[0]?.id;
    if (!productId) return;

    const result = await shopify.query(
      `query GetHandle($id: ID!) { product(id: $id) { handle } }`,
      { variables: { id: productId } }
    );

    const handle = result?.data?.product?.handle;
    if (!handle) return;

    window.open(`/admin/apps/${APP_HANDLE}/app/products/${handle}/edit`, "_top");

    shopify.close();

  } 
  catch (err) 
  {
    console.error("Error:", err);
  }
}