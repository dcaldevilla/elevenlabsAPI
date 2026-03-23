import express from "express";
import "dotenv/config";
import he from "he";

const app = express();
app.use(express.json());

const SHOP = process.env.SHOPIFY_SHOP;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
const API_KEY = process.env.MW_API_KEY;
const VITORIA_LOCATION_ID = process.env.SHOPIFY_VITORIA_LOCATION_ID;

// Health check sin protección (permite checks externos sin API key)
app.get("/health", (req, res) => res.json({ ok: true }));

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: "MW_API_KEY not set" });
  const k = req.header("X-API-Key");
  if (k !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.use(requireApiKey);

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${text}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function parseSku(text) {
  const s = (text || "").trim();
  const m = s.match(/^(.*?)\s*\(\s*([0-9]+)\s*\)\s*$/);
  if (m) return { ref: m[1].trim(), code: m[2].trim(), raw: s };
  if (/^\d{6,}$/.test(s)) return { ref: null, code: s, raw: s };
  return { ref: s, code: null, raw: s };
}

function normalizeQuery(s) {
  return (s || "")
    .replace(/[\s\-]/g, "")               // quita espacios y guiones
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")  // letra→número: "U20" → "U 20"
    .replace(/(\d)([a-zA-Z])/g, "$1 $2"); // número→letra: "1993U" → "1993 U"
}

function htmlToText(html = "") {
  return he.decode(
    html
      .replace(/<\/li>\s*<li>/g, "\n- ")
      .replace(/<li>/g, "- ")
      .replace(/<\/li>/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\n{2,}/g, "\n")
      .trim()
  );
}

const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

const VARIANT_DESC_QUERY = `
  query VariantDesc($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      variantTitle: metafield(namespace: "custom", key: "variant_title") {
        value
      }
      mpn: metafield(namespace: "mm-google-shopping", key: "mpn") {
        value
      }
      product { id title vendor descriptionHtml }
    }
  }
`;

async function fetchVariantDescription(variant_id) {
  const data = await shopifyGraphQL(VARIANT_DESC_QUERY, { id: variant_id });
  const v = data.productVariant;
  if (!v) return null;
  return {
    variant_id: v.id,
    sku: parseSku(v.sku).ref ?? v.sku,
    title: v.product?.title,
    vendor: v.product?.vendor,
    variant_title: v.variantTitle?.value ?? null,
    codigo: v.mpn?.value ?? null,
    description_text: v.product?.descriptionHtml ? htmlToText(v.product.descriptionHtml) : null,
  };
}

app.post("/resolve_reference", async (req, res) => {
  try {
    const { text } = req.body;
    const { ref, code, raw } = parseSku(text);

    const qCandidates = [];
    const normRaw = normalizeQuery(raw);
    const normRef = ref ? normalizeQuery(ref) : null;

    // stripped: quita TODOS los separadores sin re-insertar espacios
    const stripped = (raw || "").replace(/[\s\-]/g, "");
    // boundary: inserta guiones en cada transición letra↔dígito del stripped
    // cubre patrones Gedore tipo "19Emu20" → "19-Emu-20"
    const boundary = stripped
      .replace(/([a-zA-Z])(\d)/g, "$1-$2")
      .replace(/(\d)([a-zA-Z])/g, "$1-$2");

    const active = "product_status:active";
    const seen = new Set();
    const addQ = (q) => { if (q && !seen.has(q)) { seen.add(q); qCandidates.push(q); } };

    // 1. exacta: lo que dijo el usuario tal cual
    if (raw) addQ(`sku:"${raw}" ${active}`);
    if (ref && ref !== raw) addQ(`sku:"${ref}" ${active}`);
    if (code) addQ(`sku:"${code}" ${active}`);

    // 2. normalizada: ignora separadores y añade espacio en transiciones letra↔dígito
    if (normRaw !== raw) addQ(`sku:"${normRaw}" ${active}`);
    if (normRef && normRef !== ref) addQ(`sku:"${normRef}" ${active}`);

    // 3. boundary-hyphenated: guiones en todas las transiciones letra↔dígito
    // ej: "19Emu20" → "19-Emu-20", "1993U20" → "1993-U-20"
    if (boundary !== raw && boundary !== stripped) addQ(`sku:"${boundary}" ${active}`);

    // 4. completamente limpia (sin ningún separador)
    // ej: "TFK 100" → "TFK100"
    if (stripped !== raw && stripped !== normRaw) addQ(`sku:"${stripped}" ${active}`);

    // 5. todas las variantes con un solo guión sobre el stripped
    // cubre casos donde el guión va entre letras: "TFK100" → "TF-K100"
    // se aplica solo a refs cortas para mantener el nº de queries razonable
    if (stripped.length >= 2 && stripped.length <= 14) {
      for (let i = 1; i < stripped.length; i++) {
        addQ(`sku:"${stripped.slice(0, i)}-${stripped.slice(i)}" ${active}`);
      }
    }

    const query = `
      query Variants($q: String!) {
        productVariants(first: 10, query: $q) {
          nodes {
            id
            sku
            barcode
            variantTitle: metafield(namespace: "custom", key: "variant_title") {
              value
            }
            mpn: metafield(namespace: "mm-google-shopping", key: "mpn") {
              value
            }
            product { id vendor }
          }
        }
      }
    `;

    let candidates = [];
    for (const q of qCandidates) {
      const data = await shopifyGraphQL(query, { q });
      const nodes = data?.productVariants?.nodes || [];
      candidates = nodes.map(v => ({
        variant_id: v.id,
        sku: parseSku(v.sku).ref ?? v.sku,
        barcode: v.barcode,
        variant_title: v.variantTitle?.value ?? null,
        codigo: v.mpn?.value ?? null,
        vendor: v.product?.vendor,
      }));
      if (candidates.length) break;
    }

    res.json({ input: text, parsed: { ref, code }, candidates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/description_text", async (req, res) => {
  try {
    const { variant_id } = req.body;
    if (!variant_id) return res.status(400).json({ error: "variant_id is required" });
    if (!VARIANT_GID_RE.test(variant_id)) {
      return res.status(400).json({ error: "variant_id must be a Shopify GID: gid://shopify/ProductVariant/{id}" });
    }

    const result = await fetchVariantDescription(variant_id);
    if (!result) return res.status(404).json({ error: "Variant not found" });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const VARIANT_WEIGHT_QUERY = `
  query VariantWeight($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      inventoryItem {
        measurement {
          weight {
            unit
            value
          }
        }
      }
    }
  }
`;

async function fetchVariantWeight(variant_id) {
  const data = await shopifyGraphQL(VARIANT_WEIGHT_QUERY, { id: variant_id });
  const v = data.productVariant;
  if (!v) return null;
  const units = { KILOGRAMS: "kg", GRAMS: "g", POUNDS: "lb", OUNCES: "oz" };
  const w = v.inventoryItem?.measurement?.weight;
  return {
    variant_id: v.id,
    sku: parseSku(v.sku).ref ?? v.sku,
    peso: w?.value != null ? `${w.value} ${units[w.unit] ?? w.unit}` : null,
  };
}

app.post("/variant_weight", async (req, res) => {
  try {
    const { variant_id } = req.body;
    if (!variant_id) return res.status(400).json({ error: "variant_id is required" });
    if (!VARIANT_GID_RE.test(variant_id)) {
      return res.status(400).json({ error: "variant_id must be a Shopify GID: gid://shopify/ProductVariant/{id}" });
    }
    const result = await fetchVariantWeight(variant_id);
    if (!result) return res.status(404).json({ error: "Variant not found" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const VARIANT_DIMENSIONS_QUERY = `
  query VariantDimensions($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      longitud: metafield(namespace: "custom", key: "longitud_mm_") {
        value
      }
      anchura: metafield(namespace: "custom", key: "anchura_mm_") {
        value
      }
      altura: metafield(namespace: "custom", key: "altura_mm_") {
        value
      }
    }
  }
`;

async function fetchVariantDimensions(variant_id) {
  const data = await shopifyGraphQL(VARIANT_DIMENSIONS_QUERY, { id: variant_id });
  const v = data.productVariant;
  if (!v) return null;
  return {
    variant_id: v.id,
    sku: parseSku(v.sku).ref ?? v.sku,
    longitud: v.longitud?.value ? `${v.longitud.value} mm` : null,
    anchura: v.anchura?.value ? `${v.anchura.value} mm` : null,
    altura: v.altura?.value ? `${v.altura.value} mm` : null,
  };
}

app.post("/variant_dimensions", async (req, res) => {
  try {
    const { variant_id } = req.body;
    if (!variant_id) return res.status(400).json({ error: "variant_id is required" });
    if (!VARIANT_GID_RE.test(variant_id)) {
      return res.status(400).json({ error: "variant_id must be a Shopify GID: gid://shopify/ProductVariant/{id}" });
    }
    const result = await fetchVariantDimensions(variant_id);
    if (!result) return res.status(404).json({ error: "Variant not found" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const VARIANT_PRICE_QUERY = `
  query VariantPrice($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      price
      compareAtPrice
      metafield(namespace: "custom", key: "variant_title") {
        value
      }
      product { vendor }
    }
  }
`;

async function fetchVariantPrice(variant_id) {
  const data = await shopifyGraphQL(VARIANT_PRICE_QUERY, { id: variant_id });
  const v = data.productVariant;
  if (!v) return null;
  return {
    variant_id: v.id,
    sku: v.sku,
    title: v.metafield?.value ?? null,
    vendor: v.product?.vendor,
    price: v.price,
    compare_at_price: v.compareAtPrice ?? null,
  };
}

app.post("/variant_price", async (req, res) => {
  try {
    const { variant_id } = req.body;
    if (!variant_id) return res.status(400).json({ error: "variant_id is required" });
    if (!VARIANT_GID_RE.test(variant_id)) {
      return res.status(400).json({ error: "variant_id must be a Shopify GID: gid://shopify/ProductVariant/{id}" });
    }

    const result = await fetchVariantPrice(variant_id);
    if (!result) return res.status(404).json({ error: "Variant not found" });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const VARIANT_STOCK_QUERY = `
  query VariantStock($id: ID!, $locationId: ID!) {
    productVariant(id: $id) {
      id
      sku
      variantTitle: metafield(namespace: "custom", key: "variant_title") {
        value
      }
      inventoryItem {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            quantity
          }
        }
      }
      stockAlemania: metafield(namespace: "stock", key: "alemania") {
        value
      }
    }
  }
`;

async function fetchVariantStock(variant_id) {
  if (!VITORIA_LOCATION_ID) throw new Error("SHOPIFY_VITORIA_LOCATION_ID not set");
  const data = await shopifyGraphQL(VARIANT_STOCK_QUERY, { id: variant_id, locationId: VITORIA_LOCATION_ID });
  const v = data.productVariant;
  if (!v) return null;
  const vitoriaQty = v.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity ?? null;
  return {
    variant_id: v.id,
    sku: v.sku,
    title: v.variantTitle?.value ?? null,
    stock_vitoria: vitoriaQty,
    stock_alemania: v.stockAlemania?.value ? Number(v.stockAlemania.value) : null,
  };
}

app.post("/variant_stock", async (req, res) => {
  try {
    const { variant_id } = req.body;
    if (!variant_id) return res.status(400).json({ error: "variant_id is required" });
    if (!VARIANT_GID_RE.test(variant_id)) {
      return res.status(400).json({ error: "variant_id must be a Shopify GID: gid://shopify/ProductVariant/{id}" });
    }

    const result = await fetchVariantStock(variant_id);
    if (!result) return res.status(404).json({ error: "Variant not found" });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
