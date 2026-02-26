import express from "express";
import "dotenv/config";

const app = express();
app.use(express.json());

const SHOP = process.env.SHOPIFY_SHOP;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
const API_KEY = process.env.MW_API_KEY; // clave para que solo ElevenLabs/tu puedas llamar

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: "MW_API_KEY not set" });
  const k = req.header("X-API-Key");
  if (k !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Proteger TODO
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

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/resolve_reference", async (req, res) => {
  try {
    const { text } = req.body;
    const { ref, code, raw } = parseSku(text);

    const qCandidates = [];

// búsqueda amplia (más flexible)
	if (raw) qCandidates.push(raw);
	if (ref) qCandidates.push(ref);
	if (code) qCandidates.push(code);

// búsqueda específica por sku como fallback
	if (raw) qCandidates.push(`sku:"${raw}"`);
	if (ref) qCandidates.push(`sku:"${ref}"`);
	if (code) qCandidates.push(`sku:"${code}"`);

    const query = `
      query Variants($q: String!) {
        productVariants(first: 10, query: $q) {
          nodes {
            id
            sku
            barcode
            product { id title vendor }
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
        sku: v.sku,
        barcode: v.barcode,
        title: v.product?.title,
        vendor: v.product?.vendor
      }));
      if (candidates.length) break;
    }

    res.json({ input: text, parsed: { ref, code }, candidates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/variant/:id/description", async (req, res) => {
  try {
    const id = req.params.id;
    const query = `
      query VariantDesc($id: ID!) {
        productVariant(id: $id) {
          id
          sku
          product { id title vendor descriptionHtml }
        }
      }
    `;
    const data = await shopifyGraphQL(query, { id });
    const v = data.productVariant;
    res.json({
      variant_id: v?.id,
      sku: v?.sku,
      product_id: v?.product?.id,
      title: v?.product?.title,
      vendor: v?.product?.vendor,
      description_html: v?.product?.descriptionHtml
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function htmlToText(html = "") {
  return html
    .replace(/<\/li>\s*<li>/g, "\n- ")
    .replace(/<li>/g, "- ")
    .replace(/<\/li>/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")          // quita el resto de tags
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

app.get("/variant/:id/description_text", async (req, res) => {
  try {
    const id = req.params.id;
    const query = `
      query VariantDesc($id: ID!) {
        productVariant(id: $id) {
          id
          sku
          product { id title vendor descriptionHtml }
        }
      }
    `;
    const data = await shopifyGraphQL(query, { id });
    const v = data.productVariant;

    const html = v?.product?.descriptionHtml || "";
    res.json({
      variant_id: v?.id,
      sku: v?.sku,
      title: v?.product?.title,
      vendor: v?.product?.vendor,
      description_text: htmlToText(html)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
