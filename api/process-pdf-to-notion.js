import fs from "fs";
import formidable from "formidable";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

export const config = {
  api: {
    bodyParser: false,
  },
};

const NOTION_VERSION = "2022-06-28";

const KEYWORD_GROUPS = {
  thesis: ["investment thesis", "thesis", "catalyst", "upside"],
  business: ["route", "fleet", "vessel", "business model", "operations", "hormuz"],
  market: ["aframax", "charter", "freight", "spot exposure", "spot earnings", "market"],
  lng: ["lng", "pln", "gas demand", "distribution network", "gas", "fsru"],
  revenue: ["revenue", "ebitda", "net profit", "margin", "cost breakdown", "revenue breakdown"],
  valuation: ["valuation", "peer comparison", "target price", "ev/ebitda", "p/e", "tp"],
  forecast: ["income statement", "balance sheet", "cash flow", "key ratios", "forecast"],
  risk: ["risk", "sensitivity", "fuel", "insurance", "gearing"],
};

const VISUAL_PRIORITY = [
  "thesis",
  "business",
  "market",
  "lng",
  "revenue",
  "valuation",
  "forecast",
  "risk",
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function cleanText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function parseForm(req) {
  const form = formidable({
    maxFileSize: 30 * 1024 * 1024,
    multiples: false,
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function getFieldValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

function scorePageText(pageText) {
  const text = pageText.toLowerCase();
  let score = 0;
  let matchedGroups = [];

  for (const [group, keywords] of Object.entries(KEYWORD_GROUPS)) {
    let localScore = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) {
        localScore += 2;
      }
    }
    if (localScore > 0) {
      matchedGroups.push(group);
      score += localScore;
    }
  }

  // boost pages with Figures/Tables
  if (/figure\s+\d+/i.test(pageText)) score += 2;
  if (/table\s+\d+/i.test(pageText)) score += 2;

  return {
    score,
    matchedGroups,
  };
}

function inferDocumentType(fileName, firstPageText) {
  const hay = `${fileName} ${firstPageText}`.toLowerCase();

  if (hay.includes("initiation")) return "Initiation Report";
  if (hay.includes("pubex")) return "Pubex";
  if (hay.includes("annual report")) return "Annual Report";
  if (hay.includes("quarterly")) return "Quarterly Report";
  if (hay.includes("presentation")) return "Presentation";
  return "Report Summary";
}

function inferTickerAndCompany(fileName, firstPageText) {
  const text = firstPageText || "";

  // try Bloomberg / Reuters line first
  const bloombergMatch = text.match(/\b([A-Z]{2,6})\.(IJ|JK)\b/);
  const reutersMatch = text.match(/\b([A-Z]{2,6})\.(JK|IJ)\b/);
  const ticker =
    bloombergMatch?.[1] ||
    reutersMatch?.[1] ||
    fileName.toUpperCase().match(/\b([A-Z]{2,6})\b/)?.[1] ||
    null;

  // try company line
  const companyMatch =
    text.match(/PT\s+[A-Za-z0-9&.,' -]+Tbk/i) ||
    text.match(/PT\s+[A-Za-z0-9&.,' -]+/i);

  const companyName = companyMatch?.[0]?.trim() || ticker || "Unknown Company";

  return {
    ticker: ticker ? ticker.toUpperCase() : null,
    companyName,
  };
}

function extractRatingAndTP(firstPageText) {
  const ratingMatch = firstPageText.match(/\b(BUY|HOLD|SELL)\b/i);
  const tpMatch = firstPageText.match(/Target Price\s*\(.*?\)\s*([0-9.,]+)/i);
  const upsideMatch = firstPageText.match(/Potential Upside\s*\(%\)\s*([0-9.,]+)/i);

  return {
    rating: ratingMatch?.[1]?.toUpperCase() || null,
    targetPrice: tpMatch?.[1] || null,
    upside: upsideMatch?.[1] || null,
  };
}

function buildPageTextAndLines(textContent, viewport) {
  const lineBuckets = new Map();

  for (const item of textContent.items || []) {
    if (!item.str || !String(item.str).trim()) continue;

    const x = item.transform[4];
    const y = item.transform[5];
    const [vx, vy] = viewport.convertToViewportPoint(x, y);

    const bucketKey = Math.round(vy / 8) * 8;
    const entry = lineBuckets.get(bucketKey) || { y: vy, parts: [] };
    entry.parts.push({ x: vx, str: item.str });
    lineBuckets.set(bucketKey, entry);
  }

  const lines = Array.from(lineBuckets.values())
    .sort((a, b) => a.y - b.y)
    .map((line) => {
      const text = line.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      return {
        y: line.y,
        text,
      };
    })
    .filter((l) => l.text);

  const pageText = lines.map((l) => l.text).join("\n");

  return { lines, pageText };
}

function getBestCategory(matchedGroups) {
  for (const group of VISUAL_PRIORITY) {
    if (matchedGroups.includes(group)) return group;
  }
  return "general";
}

function selectRelevantPages(pageMetas, maxVisuals = 6) {
  const sorted = [...pageMetas]
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const usedGroups = new Set();

  for (const page of sorted) {
    const group = getBestCategory(page.matchedGroups);

    // prefer diverse categories first
    if (!usedGroups.has(group)) {
      selected.push(page);
      usedGroups.add(group);
    }

    if (selected.length >= maxVisuals) break;
  }

  // fill remaining slots
  if (selected.length < maxVisuals) {
    for (const page of sorted) {
      if (!selected.find((x) => x.pageNumber === page.pageNumber)) {
        selected.push(page);
      }
      if (selected.length >= maxVisuals) break;
    }
  }

  return selected.slice(0, maxVisuals);
}

function chooseCaption(pageMeta) {
  const category = getBestCategory(pageMeta.matchedGroups);

  const map = {
    thesis: "Investment thesis visual",
    business: "Business / route / operations visual",
    market: "Market chart / freight / spot exposure visual",
    lng: "LNG demand / network / growth visual",
    revenue: "Revenue / cost / profitability visual",
    valuation: "Valuation / peer comparison visual",
    forecast: "Forecast / financial statement visual",
    risk: "Risk / sensitivity visual",
    general: "Relevant report visual",
  };

  return map[category] || "Relevant report visual";
}

function chooseThesisImpact(pageMeta) {
  const category = getBestCategory(pageMeta.matchedGroups);

  const map = {
    thesis: "Directly supports the main investment thesis.",
    business: "Supports the operational or strategic positioning thesis.",
    market: "Supports market-upside / cyclical earnings leverage thesis.",
    lng: "Supports growth optionality from LNG or related expansion.",
    revenue: "Shows business mix, operating leverage, or cost exposure.",
    valuation: "Supports valuation or rerating argument.",
    forecast: "Supports earnings / balance sheet / forecast assumptions.",
    risk: "Highlights downside risks or key monitoring points.",
    general: "Relevant supporting context for the investment note.",
  };

  return map[category] || "Relevant supporting context for the investment note.";
}

function findFigureAnchors(lines) {
  return lines
    .filter((line) => {
      const t = line.text.toLowerCase();
      return (
        /^figure\s+\d+/i.test(line.text) ||
        /^table\s+\d+/i.test(line.text) ||
        t.includes("peer comparison") ||
        t.includes("revenue breakdown") ||
        t.includes("cost breakdown") ||
        t.includes("income statement") ||
        t.includes("cash flow") ||
        t.includes("key ratios") ||
        t.includes("valuation")
      );
    })
    .map((line) => ({
      y: line.y,
      text: line.text,
    }))
    .sort((a, b) => a.y - b.y);
}

function chooseCropBox(pageMeta, pageWidth, pageHeight) {
  const anchors = findFigureAnchors(pageMeta.lines);

  if (anchors.length > 0) {
    const topAnchor = anchors[0];
    const nextAnchor = anchors[1];

    const top = clamp(topAnchor.y - 20, 0, pageHeight - 200);
    const bottom = nextAnchor
      ? clamp(nextAnchor.y - 20, top + 180, pageHeight - 10)
      : clamp(top + pageHeight * 0.38, top + 180, pageHeight - 10);

    return {
      x: 20,
      y: top,
      width: pageWidth - 40,
      height: bottom - top,
    };
  }

  // fallback by category
  const category = getBestCategory(pageMeta.matchedGroups);

  if (category === "forecast" || category === "revenue" || category === "valuation") {
    return {
      x: 20,
      y: pageHeight * 0.28,
      width: pageWidth - 40,
      height: pageHeight * 0.42,
    };
  }

  if (category === "business" || category === "market" || category === "lng") {
    return {
      x: 20,
      y: pageHeight * 0.18,
      width: pageWidth - 40,
      height: pageHeight * 0.45,
    };
  }

  return {
    x: 20,
    y: pageHeight * 0.22,
    width: pageWidth - 40,
    height: pageHeight * 0.42,
  };
}

async function renderCroppedPageBuffer(pdfDocument, pageNumber, cropBox, scale = 2) {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  const canvasFactory = new NodeCanvasFactory();
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);

  await page.render({
    canvasContext: context,
    viewport,
    canvasFactory,
  }).promise;

  const cropCanvas = createCanvas(cropBox.width, cropBox.height);
  const cropCtx = cropCanvas.getContext("2d");

  cropCtx.drawImage(
    canvas,
    cropBox.x,
    cropBox.y,
    cropBox.width,
    cropBox.height,
    0,
    0,
    cropBox.width,
    cropBox.height
  );

  return cropCanvas.toBuffer("image/png");
}

async function uploadBufferToCloudinary(buffer, { publicId, folder, fileName }) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error("Missing CLOUDINARY_CLOUD_NAME or CLOUDINARY_UPLOAD_PRESET");
  }

  const base64 = buffer.toString("base64");
  const dataUri = `data:image/png;base64,${base64}`;

  const form = new FormData();
  form.append("file", dataUri);
  form.append("upload_preset", uploadPreset);
  form.append("folder", folder || "notion-pdf-crops");

  if (publicId) form.append("public_id", publicId);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    {
      method: "POST",
      body: form,
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Cloudinary upload failed: ${JSON.stringify(data)}`);
  }

  return {
    secure_url: data.secure_url,
    public_id: data.public_id,
    width: data.width,
    height: data.height,
    format: data.format,
    bytes: data.bytes,
    fileName,
  };
}

async function notionFetch(path, options = {}) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("Missing NOTION_TOKEN");

  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Notion API error: ${JSON.stringify(data)}`);
  }

  return data;
}

function getNotionPageTitle(page) {
  const titleProp = page?.properties?.title?.title;
  if (Array.isArray(titleProp) && titleProp.length > 0) {
    return titleProp.map((t) => t.plain_text).join("").trim();
  }
  return "";
}

async function searchCompanyPage({ ticker, companyName }) {
  const queries = [ticker, companyName].filter(Boolean);

  for (const query of queries) {
    const data = await notionFetch("/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        filter: {
          property: "object",
          value: "page",
        },
      }),
    });

    const pages = data.results || [];

    if (ticker) {
      const exactTicker = pages.find((p) => getNotionPageTitle(p).toUpperCase() === ticker.toUpperCase());
      if (exactTicker) return exactTicker;
    }

    if (companyName) {
      const exactCompany = pages.find((p) => {
        const title = getNotionPageTitle(p).toLowerCase();
        return title === companyName.toLowerCase();
      });
      if (exactCompany) return exactCompany;
    }

    if (pages.length > 0) return pages[0];
  }

  return null;
}

async function createCompanyPage({ ticker, companyName }) {
  const rootPageId = process.env.NOTION_COMPANY_ROOT_PAGE_ID;
  if (!rootPageId) {
    throw new Error("Missing NOTION_COMPANY_ROOT_PAGE_ID for auto-create company page");
  }

  const title = ticker || companyName || "Unknown Company";

  const page = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: {
        type: "page_id",
        page_id: rootPageId,
      },
      properties: {
        title: [
          {
            type: "text",
            text: {
              content: title,
            },
          },
        ],
      },
      children: [
        {
          object: "block",
          type: "heading_1",
          heading_1: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: title,
                },
              },
            ],
          },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: companyName || title,
                },
              },
            ],
          },
        },
      ],
    }),
  });

  return page;
}

async function findOrCreateCompanyPage({ ticker, companyName, explicitParentPageId }) {
  if (explicitParentPageId) {
    return {
      id: explicitParentPageId,
      url: null,
      created: false,
      title: ticker || companyName || "Explicit Parent",
    };
  }

  const found = await searchCompanyPage({ ticker, companyName });
  if (found) {
    return {
      id: found.id,
      url: found.url,
      created: false,
      title: getNotionPageTitle(found),
    };
  }

  const created = await createCompanyPage({ ticker, companyName });
  return {
    id: created.id,
    url: created.url,
    created: true,
    title: getNotionPageTitle(created),
  };
}

function richText(text) {
  if (!text) return [];
  return [
    {
      type: "text",
      text: {
        content: String(text).slice(0, 2000),
      },
    },
  ];
}

function headingBlock(text, level = 2) {
  const type = level === 1 ? "heading_1" : level === 3 ? "heading_3" : "heading_2";
  return {
    object: "block",
    type,
    [type]: {
      rich_text: richText(text),
    },
  };
}

function paragraphBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: richText(text),
    },
  };
}

function bulletBlock(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: richText(text),
    },
  };
}

function dividerBlock() {
  return {
    object: "block",
    type: "divider",
    divider: {},
  };
}

function imageBlock(url, caption) {
  return {
    object: "block",
    type: "image",
    image: {
      type: "external",
      external: { url },
      caption: caption ? richText(caption) : [],
    },
  };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function buildExecutiveSummary({ ticker, companyName, rating, targetPrice, upside, documentType }) {
  const bits = [];

  bits.push(`${companyName}${ticker ? ` (${ticker})` : ""} — ${documentType}.`);

  if (rating) bits.push(`Rating: ${rating}.`);
  if (targetPrice) bits.push(`Target price: ${targetPrice}.`);
  if (upside) bits.push(`Potential upside: ${upside}%.`);

  bits.push(
    "This page was generated automatically from the uploaded PDF using a heuristic summary and selected thesis-relevant visuals."
  );

  return bits.join(" ");
}

function buildThesisPoints(selectedPages) {
  return selectedPages.map((p) => ({
    title: chooseCaption(p),
    description: cleanText(p.pageText).slice(0, 500),
    impact: chooseThesisImpact(p),
  }));
}

function extractKeyNumbers(firstPageText) {
  const lines = firstPageText
    .split("\n")
    .map((l) => cleanText(l))
    .filter(Boolean);

  const targets = [
    "Revenue",
    "EBITDA",
    "Net Profit",
    "EPS",
    "Target Price",
    "Potential Upside",
    "EV/EBITDA",
    "P/E",
  ];

  const out = [];

  for (const target of targets) {
    const line = lines.find((l) => l.toLowerCase().includes(target.toLowerCase()));
    if (line) {
      out.push({
        metric: target,
        value: line.slice(0, 180),
      });
    }
  }

  return out.slice(0, 10);
}

function buildThesisChangeLog(selectedPages) {
  return selectedPages.map((p) => ({
    source_page: p.pageNumber,
    update: chooseCaption(p),
    impact: chooseThesisImpact(p),
  }));
}

function buildWatchlist(selectedPages) {
  const items = new Set();

  for (const p of selectedPages) {
    if (p.matchedGroups.includes("risk")) items.add("Monitor risk and sensitivity factors highlighted in the report.");
    if (p.matchedGroups.includes("forecast")) items.add("Monitor execution against forecast assumptions and balance sheet outlook.");
    if (p.matchedGroups.includes("valuation")) items.add("Monitor whether valuation upside is supported by realized performance.");
    if (p.matchedGroups.includes("revenue")) items.add("Monitor revenue mix, margins, and cost sensitivity.");
    if (p.matchedGroups.includes("lng")) items.add("Monitor execution of LNG-related expansion or contracts.");
    if (p.matchedGroups.includes("market")) items.add("Monitor market / cyclical indicators that drive earnings leverage.");
  }

  if (items.size === 0) {
    items.add("Monitor any thesis-changing updates from future company disclosures.");
  }

  return Array.from(items);
}

async function createNotionReportPage({
  parentPageId,
  title,
  sourceFile,
  executiveSummary,
  thesisPoints,
  keyVisuals,
  keyNumbers,
  thesisChangeLog,
  watchlist,
  conclusion,
}) {
  const blocks = [];

  blocks.push(headingBlock(title, 1));
  blocks.push(paragraphBlock(`Source: ${sourceFile}`));
  blocks.push(dividerBlock());

  blocks.push(headingBlock("Executive Summary", 2));
  blocks.push(paragraphBlock(executiveSummary));

  if (thesisPoints?.length) {
    blocks.push(headingBlock("Investment Thesis", 2));
    for (const item of thesisPoints) {
      blocks.push(headingBlock(item.title, 3));
      blocks.push(paragraphBlock(item.description));
      blocks.push(paragraphBlock(`Thesis impact: ${item.impact}`));
    }
  }

  if (keyVisuals?.length) {
    blocks.push(headingBlock("Key Visuals", 2));
    for (const visual of keyVisuals) {
      blocks.push(headingBlock(`Page ${visual.page_number} — ${visual.caption}`, 3));
      blocks.push(imageBlock(visual.secure_url, visual.caption));
      blocks.push(paragraphBlock(`Thesis impact: ${visual.thesis_impact}`));
    }
  }

  if (keyNumbers?.length) {
    blocks.push(headingBlock("Key Numbers", 2));
    for (const row of keyNumbers) {
      blocks.push(bulletBlock(`${row.metric}: ${row.value}`));
    }
  }

  if (thesisChangeLog?.length) {
    blocks.push(headingBlock("Thesis Change Log", 2));
    for (const row of thesisChangeLog) {
      blocks.push(
        bulletBlock(
          `Source page ${row.source_page}: ${row.update} | Impact: ${row.impact}`
        )
      );
    }
  }

  if (watchlist?.length) {
    blocks.push(headingBlock("Watchlist / Risks", 2));
    for (const item of watchlist) {
      blocks.push(bulletBlock(item));
    }
  }

  if (conclusion) {
    blocks.push(headingBlock("Conclusion", 2));
    blocks.push(paragraphBlock(conclusion));
  }

  const firstChildren = blocks.slice(0, 90);

  const page = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: {
        type: "page_id",
        page_id: parentPageId,
      },
      properties: {
        title: [
          {
            type: "text",
            text: {
              content: title,
            },
          },
        ],
      },
      children: firstChildren,
    }),
  });

  const remaining = blocks.slice(90);
  const chunks = chunkArray(remaining, 90);

  for (const chunk of chunks) {
    await notionFetch(`/blocks/${page.id}/children`, {
      method: "PATCH",
      body: JSON.stringify({
        children: chunk,
      }),
    });
  }

  return page;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "process-pdf-to-notion endpoint is alive",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
      });
    }

    const { fields, files } = await parseForm(req);

    const rawFile = files.file;
    const pdfFile = Array.isArray(rawFile) ? rawFile[0] : rawFile;

    if (!pdfFile) {
      return res.status(400).json({
        ok: false,
        error: "Missing file field",
      });
    }

    const explicitParentPageId = getFieldValue(fields.parent_page_id, null);
    const explicitTitle = getFieldValue(fields.title, null);
    const maxVisuals = Number(getFieldValue(fields.max_visuals, 6)) || 6;
    const folder = getFieldValue(fields.folder, "notion-pdf-crops");

    const originalFileName = pdfFile.originalFilename || "uploaded-report.pdf";
    const pdfBuffer = fs.readFileSync(pdfFile.filepath);

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
    });

    const pdfDocument = await loadingTask.promise;
    const totalPages = pdfDocument.numPages;

    const pageMetas = [];

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const { lines, pageText } = buildPageTextAndLines(textContent, viewport);

      const { score, matchedGroups } = scorePageText(pageText);

      pageMetas.push({
        pageNumber,
        pageText,
        lines,
        score,
        matchedGroups,
        width: viewport.width,
        height: viewport.height,
      });
    }

    const firstPageText = pageMetas[0]?.pageText || "";
    const { ticker, companyName } = inferTickerAndCompany(originalFileName, firstPageText);
    const documentType = inferDocumentType(originalFileName, firstPageText);
    const { rating, targetPrice, upside } = extractRatingAndTP(firstPageText);

    const parentPage = await findOrCreateCompanyPage({
      ticker,
      companyName,
      explicitParentPageId,
    });

    const selectedPages = selectRelevantPages(pageMetas, maxVisuals);

    const uploadedVisuals = [];

    for (const pageMeta of selectedPages) {
      const cropBox = chooseCropBox(pageMeta, pageMeta.width * 2, pageMeta.height * 2);
      const pngBuffer = await renderCroppedPageBuffer(
        pdfDocument,
        pageMeta.pageNumber,
        cropBox,
        2
      );

      const shortDesc = getBestCategory(pageMeta.matchedGroups);
      const publicId = `${(ticker || companyName || "company")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")}_${documentType
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")}_p${pageMeta.pageNumber}_${shortDesc}`;

      const upload = await uploadBufferToCloudinary(pngBuffer, {
        publicId,
        folder,
        fileName: `${publicId}.png`,
      });

      uploadedVisuals.push({
        page_number: pageMeta.pageNumber,
        caption: chooseCaption(pageMeta),
        thesis_impact: chooseThesisImpact(pageMeta),
        secure_url: upload.secure_url,
      });
    }

    const reportTitle =
      explicitTitle ||
      `${ticker || companyName} — ${documentType}`;

    const executiveSummary = buildExecutiveSummary({
      ticker,
      companyName,
      rating,
      targetPrice,
      upside,
      documentType,
    });

    const thesisPoints = buildThesisPoints(selectedPages);
    const keyNumbers = extractKeyNumbers(firstPageText);
    const thesisChangeLog = buildThesisChangeLog(selectedPages);
    const watchlist = buildWatchlist(selectedPages);
    const conclusion =
      "This report page was auto-generated from the PDF. Review the embedded visuals and summary for thesis-relevant changes and follow-up analysis.";

    const notionPage = await createNotionReportPage({
      parentPageId: parentPage.id,
      title: reportTitle,
      sourceFile: originalFileName,
      executiveSummary,
      thesisPoints,
      keyVisuals: uploadedVisuals,
      keyNumbers,
      thesisChangeLog,
      watchlist,
      conclusion,
    });

    return res.status(200).json({
      ok: true,
      ticker,
      company_name: companyName,
      document_type: documentType,
      parent_page_id: parentPage.id,
      parent_page_created: parentPage.created,
      selected_pages: selectedPages.map((p) => p.pageNumber),
      visuals_uploaded: uploadedVisuals.length,
      notion_page_id: notionPage.id,
      notion_page_url: notionPage.url,
      uploaded_visuals: uploadedVisuals,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "PROCESS_PDF_TO_NOTION_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
