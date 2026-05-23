const NOTION_VERSION = "2022-06-28";

async function notionFetch(path, options = {}) {
  const token = process.env.NOTION_TOKEN;

  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    ok: res.ok,
    status: res.status,
    data,
  };
}

export default async function handler(req, res) {
  try {
    const token = process.env.NOTION_TOKEN;
    const rootPageId = process.env.NOTION_COMPANY_ROOT_PAGE_ID;

    if (!token) {
      return res.status(500).json({
        ok: false,
        step: "env_check",
        error: "Missing NOTION_TOKEN",
      });
    }

    if (!rootPageId) {
      return res.status(500).json({
        ok: false,
        step: "env_check",
        error: "Missing NOTION_COMPANY_ROOT_PAGE_ID",
      });
    }

    // 1. Test access root page
    const pageCheck = await notionFetch(`/pages/${rootPageId}`, {
      method: "GET",
    });

    if (!pageCheck.ok) {
      return res.status(500).json({
        ok: false,
        step: "read_root_page",
        root_page_id: rootPageId,
        notion_status: pageCheck.status,
        notion_response: pageCheck.data,
        likely_issue:
          "Root page ID salah, atau page belum di-share/connect ke Notion integration.",
      });
    }

    // 2. Test search
    const searchCheck = await notionFetch("/search", {
      method: "POST",
      body: JSON.stringify({
        query: "BULL",
        filter: {
          property: "object",
          value: "page",
        },
        page_size: 5,
      }),
    });

    if (!searchCheck.ok) {
      return res.status(500).json({
        ok: false,
        step: "search_page",
        notion_status: searchCheck.status,
        notion_response: searchCheck.data,
      });
    }

    // 3. Test create page
    const createCheck = await notionFetch("/pages", {
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
                content: "TESTAUTO — Notion API Debug",
              },
            },
          ],
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content:
                      "This page was created by debug-notion endpoint. You can delete it.",
                  },
                },
              ],
            },
          },
        ],
      }),
    });

    if (!createCheck.ok) {
      return res.status(500).json({
        ok: false,
        step: "create_test_page",
        root_page_id: rootPageId,
        notion_status: createCheck.status,
        notion_response: createCheck.data,
        likely_issue:
          "Integration bisa baca root page, tapi tidak punya permission create/edit di page tersebut.",
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Notion connection works",
      root_page_id: rootPageId,
      root_page_title:
        pageCheck.data?.properties
          ? Object.values(pageCheck.data.properties)
              .find((p) => p.type === "title")
              ?.title?.map((t) => t.plain_text)
              ?.join("")
          : null,
      search_result_count: searchCheck.data?.results?.length || 0,
      test_page_id: createCheck.data?.id,
      test_page_url: createCheck.data?.url,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      step: "unexpected_error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
