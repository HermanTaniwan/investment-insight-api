const NOTION_VERSION = "2022-06-28";

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

function paragraphBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: richText(text),
    },
  };
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

function imageBlock(url, caption) {
  return {
    object: "block",
    type: "image",
    image: {
      type: "external",
      external: {
        url,
      },
      caption: caption ? richText(caption) : [],
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

function tableLikeBlock(title, rows) {
  const blocks = [headingBlock(title, 2)];

  if (!Array.isArray(rows)) return blocks;

  for (const row of rows) {
    if (typeof row === "string") {
      blocks.push(bulletBlock(row));
    } else {
      const line = Object.entries(row)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" | ");
      blocks.push(bulletBlock(line));
    }
  }

  return blocks;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

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

  const data = await res.json();

  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "create-notion-report endpoint is alive",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
      });
    }

    if (!process.env.NOTION_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "Missing NOTION_TOKEN",
      });
    }

    const {
      parent_page_id,
      title,
      source_file,
      executive_summary,
      thesis_points,
      key_visuals,
      key_numbers,
      thesis_change_log,
      watchlist,
      conclusion,
    } = req.body || {};

    if (!parent_page_id || !title) {
      return res.status(400).json({
        ok: false,
        error: "Missing parent_page_id or title",
      });
    }

    const blocks = [];

    if (source_file) {
      blocks.push(paragraphBlock(`Source: ${source_file}`));
      blocks.push(dividerBlock());
    }

    if (executive_summary) {
      blocks.push(headingBlock("Executive Summary", 2));
      blocks.push(paragraphBlock(executive_summary));
    }

    if (Array.isArray(thesis_points) && thesis_points.length > 0) {
      blocks.push(headingBlock("Investment Thesis", 2));

      for (const item of thesis_points) {
        blocks.push(headingBlock(item.title || "Thesis Point", 3));
        if (item.description) blocks.push(paragraphBlock(item.description));
        if (item.impact) blocks.push(paragraphBlock(`Thesis impact: ${item.impact}`));
      }
    }

    if (Array.isArray(key_visuals) && key_visuals.length > 0) {
      blocks.push(headingBlock("Key Visuals", 2));

      for (const visual of key_visuals) {
        blocks.push(
          headingBlock(
            `Page ${visual.page_number || "-"} — ${visual.caption || "Key visual"}`,
            3
          )
        );

        if (visual.secure_url) {
          blocks.push(imageBlock(visual.secure_url, visual.caption || ""));
        }

        if (visual.thesis_impact) {
          blocks.push(paragraphBlock(`Thesis impact: ${visual.thesis_impact}`));
        }
      }
    }

    if (Array.isArray(key_numbers) && key_numbers.length > 0) {
      blocks.push(...tableLikeBlock("Key Numbers", key_numbers));
    }

    if (Array.isArray(thesis_change_log) && thesis_change_log.length > 0) {
      blocks.push(...tableLikeBlock("Thesis Change Log", thesis_change_log));
    }

    if (Array.isArray(watchlist) && watchlist.length > 0) {
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
          page_id: parent_page_id,
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

    const remainingBlocks = blocks.slice(90);
    const chunks = chunkArray(remainingBlocks, 90);

    for (const chunk of chunks) {
      await notionFetch(`/blocks/${page.id}/children`, {
        method: "PATCH",
        body: JSON.stringify({
          children: chunk,
        }),
      });
    }

    return res.status(200).json({
      ok: true,
      notion_page_id: page.id,
      notion_url: page.url,
      blocks_created: blocks.length,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "CREATE_NOTION_REPORT_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
