import ProductEditHeader from "../components/ProductEditHeader";
import { useLoaderData, useActionData, useSubmit, useNavigation, useFetcher } from "react-router";
import { useState, useCallback, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
// LOADER 
export const loader = async ({ request, params }) => {

  if (!params.handle) {
    
    throw new Response("Handle is required to load product", { status: 400 });
    
  }

  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") || "pricing";

  let admin;
  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
  } catch {
    throw new Response("Unauthorized session", { status: 401 });
  }
  //Pricing tab query
  if (tab === "pricing") {
    const response = await admin.graphql(`
      query GetProductPricing($handle: String!) {
        shop { currencyCode }
        productByHandle(handle: $handle) {
          id
          title
          variants(first: 1) {
            edges {
              node {
                id
                price
                compareAtPrice
                taxable
                taxCode
                inventoryItem {
                  id
                  unitCost { amount }
                }
              }
            }
          }
        }
      }
    `, { variables: { handle: params.handle } });

    const data = await response.json();
    const product = data.data?.productByHandle;
    if (!product) throw new Response("Product not found", { status: 404 });

    const v = product.variants.edges[0]?.node;
    return {
      handle: params.handle,
      tab: "pricing",
      productId: product.id,
      variantId: v.id,
      productTitle: product.title,
      inventoryItemId: v.inventoryItem?.id ?? "",
      pricing: {
        price: v.price ?? "",
        compareAtPrice: v.compareAtPrice ?? "",
        costPerItem: v.inventoryItem?.unitCost?.amount ?? "",
        taxable: v.taxable ?? false,
        taxCode: v.taxCode ?? "",
        currency: data.data?.shop?.currencyCode ?? "",
      },
    };
  }

  // Inventory tab query
  try {
    const response = await admin.graphql(`
      query GetProductInventory($handle: String!) {
        productByHandle(handle: $handle) {
          id
          variants(first: 1) {
            edges {
              node {
                id
                inventoryPolicy
                sku
                barcode
                inventoryItem {
                  id
                  tracked
                  inventoryLevels(first: 10) {
                    edges {
                      node {
                        quantities(names: ["available"]) { quantity }
                        location { id name }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { variables: { handle: params.handle } });

    const data = await response.json();
    const product = data.data?.productByHandle;
    if (!product) throw new Response("Product not found", { status: 404 });

    const v = product.variants.edges[0]?.node;
    const inventoryItem = v.inventoryItem;
    const levels = inventoryItem?.inventoryLevels?.edges ?? [];

    const locations = levels.map((edge) => ({
      id: edge.node.location.id,
      name: edge.node.location.name,
      quantity: String(edge.node.quantities?.[0]?.quantity ?? 0),
    }));
    const firstLevel = locations[0] ?? {};

    return {
      handle: params.handle,
      tab: "inventory",
      productId: product.id,
      variantId: v.id,
      inventory: {
        tracked: inventoryItem?.tracked ?? false,
        quantity: firstLevel.quantity ?? "0",
        locationId: firstLevel.id ?? "",
        locationName: firstLevel.name ?? "",
        locations,
        inventoryItemId: inventoryItem?.id ?? "",
        overselling: v.inventoryPolicy === "CONTINUE",
        sku: v.sku ?? "",
        barcode: v.barcode ?? "",
      },
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: "Unable to load inventory data right now. Please try again." };
  }
};

// ACTION 

export const action = async ({ request, params }) => {
  if (!params.handle) {
    return { error: "Handle is required to update product" };
  }

  let admin;
  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
  } catch {
    throw new Response("Unauthorized session", { status: 401 });
  }

  const formData = await request.formData();
  const _tab = formData.get("_tab");

  if (_tab !== "pricing" && _tab !== "inventory" && _tab !== "all") {
    return { error: "Unsupported tab" };
  }

  let payload;
  try {
    payload = JSON.parse(formData.get("payload"));
  } catch {
    return { error: "Invalid product payload" };
  }

  const { pricing, inventory, productId, variantId, inventoryItemId } = payload;
  let mutationsFired = 0;

  //Pricing tab
  if (_tab === "pricing" || _tab === "all") {
    
    if (pricing) {
      const current = pricing.current;
      const original = pricing.original;
      if (!current || !original) 
        return { error: "Invalid product payload" };

      if (!current.price || parseFloat(current.price) <= 0) {
        return { error: "Price must be greater than zero." };
      }
      if (current.compareAtPrice && parseFloat(current.compareAtPrice) <= parseFloat(current.price)) {
        return { error: "Compare-at price must be greater than the selling price." };
      }
    
      if (current.taxCode && !/^[a-zA-Z0-9]+$/.test(current.taxCode)) {
        return { error: "Tax code must be alphanumeric." };
      }

      const pricingChanged =
        current.price !== original.price ||
        current.compareAtPrice !== original.compareAtPrice ||
        current.costPerItem !== original.costPerItem ||
        current.taxable !== original.taxable ||
        current.taxCode !== original.taxCode;

      if (pricingChanged) {
        try {
          const result = await admin.graphql(`
            mutation UpdatePricing($productId: ID!, $variants: [ProductVariantsBulkInput!]!) 
            {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) 
              {
                productVariants 
                { 
                  id 
                  price 
                  compareAtPrice 
                  taxable 
                  taxCode 
                }
                userErrors { field message }
              }
            }
          `, {
            variables: {
              productId,
              variants: [{
                id: variantId,
                price: current.price,
                compareAtPrice: current.compareAtPrice || null,
                taxable: current.taxable,
                taxCode: current.taxCode || null,
              }],
            },
          });

          const resultData = await result.json();
          const errors = resultData.data?.productVariantsBulkUpdate?.userErrors;
          if (errors?.length > 0) 
            return { error: "Unable to update product right now. Please try again." };
          mutationsFired++;

          if (current.costPerItem !== original.costPerItem && inventoryItemId) {
            const costResult = await admin.graphql(`
              mutation UpdateCost($id: ID!, $input: InventoryItemInput!) {
                inventoryItemUpdate(id: $id, input: $input) {
                  userErrors { field message }
                }
              }
            `, {
              variables: {
                id: inventoryItemId,
                input: { cost: current.costPerItem ? String(current.costPerItem) : null },
              },
            });
            const costErrors = (await costResult.json()).data?.inventoryItemUpdate?.userErrors;
            if (costErrors?.length > 0) 
              return { error: "Unable to update product right now. Please try again." };
            mutationsFired++;
          }
        } catch {
          return { error: "Unable to update product right now. Please try again." };
        }
      }
    }
  }

  // Inventory tab
  if (_tab === "inventory" || _tab === "all") {
    if (inventory) {
      
      const current = inventory.current;
      const original = inventory.original;

      if (!current || !original) 
        return { error: "Invalid product payload" };

      if (current.tracked) {
        const qty = Number(current.quantity);
        if (!Number.isInteger(qty) || qty < 0) {
          return { error: "Quantity must be a whole number greater than or equal to 0." };
        }
      }
  

    // SKU uniqueness check
    const trimmedSku = current.sku?.trim() ?? "";
    const skuChanged = trimmedSku !== (original.sku?.trim() ?? "");

    if (skuChanged && trimmedSku) {
      try {
        const skuCheckResult = await admin.graphql(`
          query CheckSkuUniqueness($query: String!) {
            productVariants(first: 15, query: $query) {
              edges {
                node
               { 
                id 
                sku 
                }
              }
            }
          }
        `, { variables: { query: `sku:"${trimmedSku}"` } });

        const skuCheckData = await skuCheckResult.json();
        const matches = skuCheckData.data?.productVariants?.edges ?? [];
        const duplicate = matches.find(
          (edge) => edge.node.id !== variantId && edge.node.sku === trimmedSku
        );

        if (duplicate) {
          return { error: `SKU "${trimmedSku}" is already in use on another product. Please choose a unique SKU.` };
        }
      } 
      catch 
      {
        return { error: "Unable to validate SKU uniqueness right now. Please try again." };
      }
    }
        const inventoryChanged =
        
        current.quantity !== original.quantity ||
        current.overselling !== original.overselling ||
        current.tracked !== original.tracked ||
        current.sku !== original.sku ||
        current.barcode !== original.barcode;

      if (inventoryChanged) {
        try {
          if (current.tracked && current.quantity !== original.quantity){
            const qtyResult = await admin.graphql(`
              mutation SetOnHandQty($input: InventorySetOnHandQuantitiesInput!) {
                inventorySetOnHandQuantities(input: $input) {
                  inventoryAdjustmentGroup 
                  { 
                    id
                  }
                  userErrors { field message }
                }
              }
            `, {
              variables: {
                input: {
                  reason: "correction",
                  setQuantities: [{
                    inventoryItemId: current.inventoryItemId,
                    locationId: current.locationId,
                    quantity: parseInt(current.quantity, 10),
                  }],
                },
              },
            });
            const qtyErrors = (await qtyResult.json()).data?.inventorySetOnHandQuantities?.userErrors;
            if (qtyErrors?.length > 0) 
              return { error: "Unable to update product right now. Please try again." };
            mutationsFired++;
          }

          if (current.overselling !== original.overselling) {
            const policyResult = await admin.graphql(`
              mutation UpdatePolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                  userErrors { field message }
                }
              }
            `, {
              variables: {
                productId,
                variants: [{ id: variantId, inventoryPolicy: current.overselling ? "CONTINUE" : "DENY" }],
              },
            });
            const policyErrors = (await policyResult.json()).data?.productVariantsBulkUpdate?.userErrors;
            if (policyErrors?.length > 0)
               return { error: "Unable to update product right now. Please try again." };
            mutationsFired++;
          }

          if ((current.tracked !== original.tracked || current.sku !== original.sku) && current.inventoryItemId) {
            const itemInput = {};
            if (current.tracked !== original.tracked) 
              itemInput.tracked = current.tracked;
            if (current.sku !== original.sku) 
              itemInput.sku = current.sku;

            const itemResult = await admin.graphql(`
              mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
                inventoryItemUpdate(id: $id, input: $input) {
                  userErrors { field message }
                }
              }
            `, { variables: { id: current.inventoryItemId, input: itemInput } });
            const itemErrors = (await itemResult.json()).data?.inventoryItemUpdate?.userErrors;
            if (itemErrors?.length > 0)
              return { error: "Unable to update product right now. Please try again." };
            mutationsFired++;
          }

          if (current.barcode !== original.barcode) {
            const barcodeResult = await admin.graphql(`
              mutation UpdateBarcode($productId: ID!, $variants: [ProductVariantsBulkInput!]!) 
              {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                  userErrors { field message }
                }
              }
            `, {
              variables: {
                productId,
                variants: [{ id: variantId, barcode: current.barcode || null }],
              },
            });
            const barcodeErrors = (await barcodeResult.json()).data?.productVariantsBulkUpdate?.userErrors;
            if (barcodeErrors?.length > 0) 
              return { error: "Unable to update product right now. Please try again." };
            mutationsFired++;
          }
        } 
        catch {
          return { error: "Unable to update product right now. Please try again." };
        }
      }
    }
  }

  if (mutationsFired === 0) {
    return { success: true, message: "No changes detected.", mutationsFired: 0 };
  }
  return { success: true, message: "Changes saved successfully!", mutationsFired };
};

// UI

export default function ProductEditPage() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const submit     = useSubmit();
  const navigation = useNavigation();
  const isSaving   = navigation.state === "submitting";

  const { handle, productId, variantId, productTitle, inventoryItemId } = loaderData;

  const initialPricing = {
    price:loaderData.pricing?.price ?? "",
    compareAtPrice:loaderData.pricing?.compareAtPrice ?? "",
    costPerItem:loaderData.pricing?.costPerItem ?? "",
    taxable:loaderData.pricing?.taxable ?? false,
    taxCode: loaderData.pricing?.taxCode ?? "",
    currency:loaderData.pricing?.currency ?? "",
  };

  const [formState, setFormState] = useState({ pricing: initialPricing, inventory: null });
  const [origState, setOrigState] = useState({ pricing: initialPricing, inventory: null });
  //Inventory lazy load
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [inventoryError,  setInventoryError]  = useState("");
  const [selectedTab,     setSelectedTab]     = useState(0);
  const inventoryFetcher   = useFetcher();
  const inventoryLoadedRef = useRef(false);

  const [bannerDismissed, setBannerDismissed] = useState(false); 

  useEffect(() => {
    if (inventoryFetcher.data && !inventoryLoadedRef.current) {
      if (inventoryFetcher.data.inventory) {
        
        const inv = {
          ...inventoryFetcher.data.inventory,
          locations: inventoryFetcher.data.inventory.locations.map((l) => ({ ...l })),
        };
        // write into current and original 
        setFormState((prev) => ({ ...prev, inventory: inv }));
        setOrigState((prev) => ({ ...prev, inventory: { ...inv, locations: inv.locations.map((l) => ({ ...l })) } }));
        setInventoryLoaded(true);
        inventoryLoadedRef.current = true;
        setInventoryError("");
      } 
      else 
      {
        setInventoryError("Unable to load inventory data right now. Please try again.");
      }
    }
  }, [inventoryFetcher.data]);

  useEffect(() => {
    if (actionData?.success) {
      const updatedInventory = formState.inventory
        ? {
            ...formState.inventory,
            locations: formState.inventory.locations.map((loc) =>
              loc.id === formState.inventory.locationId
                ? { ...loc, quantity: formState.inventory.quantity }
                : loc
            ),
          }
        : null;

      setFormState((prev) => ({
        ...prev,
        inventory: updatedInventory,
      }));

      setOrigState({
        pricing: { ...formState.pricing },
        inventory: updatedInventory
          ? {
              ...updatedInventory,
              locations: updatedInventory.locations.map((l) => ({ ...l })),
            }
          : null,
      });
    }
  }, [actionData]);

  const handleTabChange = useCallback((tabIndex) => {
    setSelectedTab(tabIndex);
    if (tabIndex === 1 && !inventoryLoadedRef.current) {
      inventoryFetcher.load(`/app/products/${handle}/edit?tab=inventory`);
    }
  }, [handle]);

  const setPricingField = (field, value) => {
    setFormState((prev) => ({
      ...prev,
      pricing: { ...prev.pricing, [field]: value },
    }));

  };

  const setInventoryField = (field, value) => {
    setFormState((prev) => ({
      ...prev,
      inventory: { ...prev.inventory, [field]: value },
    }));
  };

  const handleLocationChange = (locationId) => {
    const loc = formState.inventory.locations.find((l) => l.id === locationId);
    if (!loc) return;
    setFormState((prev) => ({
      ...prev,
      inventory: {
        ...prev.inventory,
        locationId:loc.id,
        locationName:loc.name,
        quantity: loc.quantity,
      },
    }));
    setOrigState((prev) => ({
      ...prev,
      inventory: {
        ...prev.inventory,
        locationId:loc.id,
        locationName:loc.name,
        quantity:loc.quantity,
      },
    }));
  };

  // isDirty
  const pricingDirty =
    formState.pricing.price !== origState.pricing.price||
    formState.pricing.compareAtPrice !== origState.pricing.compareAtPrice ||
    formState.pricing.costPerItem !== origState.pricing.costPerItem ||
    formState.pricing.taxable!== origState.pricing.taxable ||
    formState.pricing.taxCode !== origState.pricing.taxCode;
  const inventoryDirty =
    inventoryLoaded &&
    formState.inventory !== null &&
    origState.inventory !== null && (
      formState.inventory.quantity !== origState.inventory.quantity ||
      formState.inventory.overselling !== origState.inventory.overselling ||
      formState.inventory.tracked !== origState.inventory.tracked ||
      formState.inventory.sku !== origState.inventory.sku ||
      formState.inventory.barcode !== origState.inventory.barcode
    );
  const isDirty = pricingDirty || inventoryDirty;
  // Save
  const handleSave = () => {
    //to display error msg
    setBannerDismissed(false);
    const payload = {
      pricing: {
        current:formState.pricing,
        original: origState.pricing,
      },
      inventory: inventoryLoaded
        ? { current: formState.inventory, original: origState.inventory }
        : null,
      productId,
      variantId,
      inventoryItemId,
    };

    const fd = new FormData();
    fd.append("_tab", "all");
    fd.append("payload", JSON.stringify(payload));
    submit(fd, { method: "post" });
  };

  // Discard
  const handleDiscard = () => {
    //after discard error msg disappear
    setBannerDismissed(true);
    setFormState({
      pricing: { ...origState.pricing },
      inventory: origState.inventory
        ? {
            ...origState.inventory,
            locations: origState.inventory.locations.map((l) => ({ ...l })),
          }
        : null,
    });
  };

  const isValidDecimal = (v) => v === "" || /^\d+(\.\d{0,2})?$/.test(v);
  const preventInvalidNumberKeys = (e) => 
    {
    if (/^[a-zA-Z+-]$/.test(e.key)) 
      e.preventDefault();
  };
  const isAlphanumeric = (v) => v === "" || /^[a-zA-Z0-9]*$/.test(v);

  const pricing = formState.pricing;
  const inventory = formState.inventory;
  const isInventoryLoading = inventoryFetcher.state === "loading";

  return (
    <div style={styles.page}>

      {/* Save & Discard*/}
      <ProductEditHeader
        title={productTitle}
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
     {/*banner*/}
      <div style={{ ...styles.bannerError,   display: actionData?.error && !bannerDismissed ? "block" : "none" }}>
        ⚠ {actionData?.error}
      </div>
      <div style={{ ...styles.bannerSuccess, display: actionData?.success && !bannerDismissed ? "block" : "none" }}>
        ✓ {actionData?.message}
      </div>

      {/*Tab */}
      <div style={styles.tabBar}>
        <button
          style={selectedTab === 0 ? styles.tabActive : styles.tab}
          onClick={() => handleTabChange(0)}
        >
          Pricing
        </button>
        <button
          style={selectedTab === 1 ? styles.tabActive : styles.tab}
          onClick={() => handleTabChange(1)}
        >
          Inventory
        </button>
      </div>

      {/* Pricing tab */}
      {selectedTab === 0 && (
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Pricing</h2>

          <div style={styles.field}>
            <label htmlFor="price" style={styles.label}>Price *</label>
            <input
              id="price"
              style={styles.input}
              type="number"
              step="0.01"
              min="0"
              value={pricing.price}
              onChange={(e) => {
                if (isValidDecimal(e.target.value))
                  setPricingField("price", e.target.value);
              }}
              onKeyDown={preventInvalidNumberKeys}
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="compareAtPrice" style={styles.label}>Compare-at Price</label>
            <input
              id="compareAtPrice"
              style={styles.input}
              type="number"
              step="0.01"
              min="0"
              value={pricing.compareAtPrice}
              onChange={(e) => {
                if (isValidDecimal(e.target.value))
                  setPricingField("compareAtPrice", e.target.value);
              }}
              onKeyDown={preventInvalidNumberKeys}
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="costPerItem" style={styles.label}>Cost per Item</label>
            <input
              id="costPerItem"
              style={styles.input}
              type="number"
              step="0.01"
              min="0"
              value={pricing.costPerItem}
              onChange={(e) => {
                if (isValidDecimal(e.target.value))
                  setPricingField("costPerItem", e.target.value);
              }}
              onKeyDown={preventInvalidNumberKeys}
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="currency" style={styles.label}>Currency</label>
            <input
              id="currency"
              style={{ ...styles.input, background: "#f7fafc", color: "#718096", cursor: "not-allowed" }}
              type="text"
              value={pricing.currency}
              readOnly
            />
          </div>

          <div style={styles.fieldRow}>
            <input
              type="checkbox"
              id="taxable"
              checked={pricing.taxable}
              onChange={(e) => setPricingField("taxable", e.target.checked)}
            />
            <label htmlFor="taxable" style={styles.checkLabel}>Charge tax on this product</label>
          </div>

          {pricing.taxable && (
            <div style={styles.field}>
              <label htmlFor="taxCode" style={styles.label}>Tax Code</label>
              <input
                id="taxCode"
                style={styles.input}
                type="text"
                value={pricing.taxCode}
                onChange={(e) => {
                  if (isAlphanumeric(e.target.value))
                    setPricingField("taxCode", e.target.value);
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Inventory tab */}
      {selectedTab === 1 && (
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Inventory</h2>

          {isInventoryLoading && <p style={styles.hint}>Loading inventory...</p>}

          {inventoryError && <div style={styles.bannerError}>⚠ {inventoryError}</div>}

          {!isInventoryLoading && !inventoryError && inventory && (
            <>
              {inventory.locations?.length > 0 && (
                <div style={styles.field}>
                  <label htmlFor="location" style={styles.label}>Location</label>
                  <select
                    id="location"
                    style={styles.input}
                    value={inventory.locationId}
                    onChange={(e) => handleLocationChange(e.target.value)}
                  >
                    {inventory.locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>{loc.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div style={styles.fieldRow}>
                <input
                  type="checkbox"
                  id="tracked"
                  checked={inventory.tracked}
                  onChange={(e) => setInventoryField("tracked", e.target.checked)}
                />
                <label htmlFor="tracked" style={styles.checkLabel}>Track quantity</label>
              </div>

              {inventory.tracked && (
                <>
                  <div style={styles.field}>
                    <label htmlFor="quantity" style={styles.label}>Quantity *</label>
                    <input
                      id="quantity"
                      style={styles.input}
                      type="number"
                      min="0"
                      step="1"
                      value={inventory.quantity}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "" || /^\d+$/.test(v))
                          setInventoryField("quantity", v);
                      }}
                      onKeyDown={preventInvalidNumberKeys}
                    />
                  </div>

                  <div style={styles.fieldRow}>
                    <input
                      type="checkbox"
                      id="overselling"
                      checked={inventory.overselling}
                      onChange={(e) => setInventoryField("overselling", e.target.checked)}
                    />
                    <label htmlFor="overselling" style={styles.checkLabel}>
                      Allow overselling (continue selling when out of stock)
                    </label>
                  </div>
                </>
              )}

              <div style={styles.field}>
                <label htmlFor="sku" style={styles.label}>SKU (Stock Keeping Unit)</label>
                <input
                  id="sku"
                  style={styles.input}
                  type="text"
                  value={inventory.sku}
                  onChange={(e) => setInventoryField("sku", e.target.value)}
                />
              </div>

              <div style={styles.field}>
                <label htmlFor="barcode" style={styles.label}>Barcode (ISBN / UPC / GTIN)</label>
                <input
                  id="barcode"
                  style={styles.input}
                  type="text"
                  value={inventory.barcode}
                  onChange={(e) => setInventoryField("barcode", e.target.value)}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
// Styles
const styles = {
  page: {
    maxWidth: 700,
    margin: "0 auto",
    padding: "24px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: "linear-gradient(45deg, #b2dfd1dc 40%, #11d4a3d0 100%)",
    minHeight: "100vh",
    borderRadius: 10,
    boxShadow: "2px 5px 15px rgba(0, 0, 0, 0.73)",
  },
  bannerError: {
    background: "#fff5f5", border: "1px solid #fc8181", borderRadius: 6,
    padding: "12px 16px", marginBottom: 16, color: "#c53030", fontSize: 14,
  },
  bannerSuccess: {
    background: "#f0fff4", border: "1px solid #68d391", borderRadius: 6,
    padding: "12px 16px", marginBottom: 16, color: "#276749", fontSize: 14,
  },
  tabBar: {
    display: "flex", gap: 4, marginBottom: 16, background: "#ffffffc3",
    padding: "6px", borderRadius: 8, border: "1px solid #e2e8f0", width: "fit-content",
  },
  tab: {
    padding: "8px 24px", borderRadius: 6, border: "none", background: "transparent",
    cursor: "pointer", fontSize: 14, color: "#718096", fontWeight: 500,
  },
  tabActive: {
    padding: "8px 24px", borderRadius: 6, border: "none",background: "#038a6adc",
    color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600,
  },
  card: { background: "#ffffffc3", border: "1px solid #e2e8f0", borderRadius: 8, padding: "24px" },
  cardTitle: {
    fontSize: 17, fontWeight: "700", marginTop: 0, marginBottom: 20,
    color: "#1a202c", paddingBottom: 12, borderBottom: "1px solid #f0f0f0",
  },
  field: { marginBottom: 18 },
  fieldRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 18 },
  label: { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6, color: "#4a5568" },
  checkLabel: { fontSize: 14, fontWeight: 500, color: "#2d3748", cursor: "pointer" },
  input: {
    width: "100%", padding: "9px 12px", border: "1px solid #cbd5e0",
    borderRadius: 6, fontSize: 14, boxSizing: "border-box", color: "#2d3748",
  },
  hint: { fontSize: 12, color: "#a0aec0", marginTop: 5, marginBottom: 0 },
  
};