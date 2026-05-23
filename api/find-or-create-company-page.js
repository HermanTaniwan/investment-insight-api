const NOTION_VERSION = "2022-06-28";

async function notionFetch(path, options = {}) {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    throw new Error("Missing NOTION_TOKEN");
  }

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
  const props = page?.properties || {};

  for (const value of Object.values(props)) {
    if (value?.type === "title" && Array.isArray(value.title)) {
      return value.title.map((t) => t.plain_text).join("").trim();
    }
  }

  return "";
}

function normalizeText(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTicker(value = "") {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function buildCompanyTitle({ ticker, company_name }) {
  const cleanTicker = normalizeTicker(ticker);
  const cleanCompany = String(company_name || "").trim();

  if (cleanTicker) return cleanTicker;
  if (cleanCompany) return cleanCompany;

  return "Unknown Company";
}

async function searchCompanyPage({ ticker, company_name }) {
  const cleanTicker = normalizeTicker(ticker);
  const cleanCompany = String(company_name || "").trim();

  const queries = [cleanTicker, cleanCompany].filter(Boolean);

  for (const query of queries) {
    const data = await notionFetch("/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        filter: {
          property: "object",
          value: "page",
        },
        page_size: 10,
      }),
    });

    const pages = data.results || [];

    if (cleanTicker) {
      const exactTicker = pages.find((page) => {
        const title = getNotionPageTitle(page);
        return normalizeTicker(title) === cleanTicker;
      });

      if (exactTicker) return exactTicker;
    }

    if (cleanCompany) {
      const exactCompany = pages.find((page) => {
        const title = getNotionPageTitle(page);
        return normalizeText(title) === normalizeText(cleanCompany);
      });

      if (exactCompany) return exactCompany;

      const companyContains = pages.find((page) => {
        const title = normalizeText(getNotionPageTitle(page));
        return (
          title.includes(normalizeText(cleanCompany)) ||
          normalizeText(cleanCompany).includes(title)
        );
      });

      if (companyContains) return companyContains;
    }

    if (pages.length > 0) {
      return pages[0];
    }
  }

  return null;
}

async function createCompanyPage({ ticker, company_name }) {
  const rootPageId = process.env.NOTION_COMPANY_ROOT_PAGE_ID;

  if (!rootPageId) {
    throw new Error("Missing NOTION_COMPANY_ROOT_PAGE_ID");
  }

  const title = buildCompanyTitle({ ticker, company_name });
  const cleanTicker = normalizeTicker(ticker);
  const cleanCompany = String(company_name || "").trim();

  const children = [];

  if (cleanCompany && cleanCompany !== title) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: cleanCompany,
            },
          },
        ],
      },
    });
  }

  if (cleanTicker) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `Ticker: ${cleanTicker}`,
            },
          },
        ],
      },
    });
  }

  children.push({
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [
        {
          type: "text",
          text: {
            content: "Investment Thesis",
          },
        },
      ],
    },
  });

  children.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: {
            content: "Main thesis page created automatically. Add company overview, thesis, risks, valuation, and updates here.",
          },
        },
      ],
    },
  });

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
      children,
    }),
  });

  return page;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "find-or-create-company-page endpoint is alive",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
      });
    }

    const { ticker, company_name, create_if_missing = true } = req.body || {};

    if (!ticker && !company_name) {
      return res.status(400).json({
        ok: false,
        error: "Missing ticker or company_name",
      });
    }

    const found = await searchCompanyPage({ ticker, company_name });

    if (found) {
      return res.status(200).json({
        ok: true,
        found: true,
        created: false,
        page_id: found.id,
        page_url: found.url,
        title: getNotionPageTitle(found),
      });
    }

    if (!create_if_missing) {
      return res.status(404).json({
        ok: false,
        found: false,
        created: false,
        error: "Company page not found",
      });
    }

    const created = await createCompanyPage({ ticker, company_name });

    return res.status(200).json({
      ok: true,
      found: false,
      created: true,
      page_id: created.id,
      page_url: created.url,
      title: getNotionPageTitle(created),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "FIND_OR_CREATE_COMPANY_PAGE_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
