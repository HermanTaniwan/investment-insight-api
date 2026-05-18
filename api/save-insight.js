import { Client } from "@notionhq/client";

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {

    const {
      title,
      summary,
      themes,
      sourceType,
      sentiment
    } = req.body;

    await notion.pages.create({

      parent: {
        database_id: process.env.NOTION_INSIGHTS_DB,
      },

      properties: {

        Title: {
          title: [
            {
              text: {
                content: title,
              },
            },
          ],
        },

        Summary: {
          rich_text: [
            {
              text: {
                content: summary,
              },
            },
          ],
        },

        Themes: {
          multi_select: themes.map((theme) => ({
            name: theme,
          })),
        },

        "Source Type": {
          select: {
            name: sourceType,
          },
        },

        Sentiment: {
          select: {
            name: sentiment,
          },
        },

        Date: {
          date: {
            start: new Date().toISOString(),
          },
        },

      },

    });

    return res.status(200).json({
      success: true,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });

  }

}
