import type { VercelRequest, VercelResponse } from "@vercel/node";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

function parseForm(req: VercelRequest): Promise<{
  fields: formidable.Fields;
  files: formidable.Files;
}> {
  const form = formidable({
    maxFileSize: 8 * 1024 * 1024,
    multiples: false,
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "upload-image endpoint is alive",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!CLOUD_NAME || !UPLOAD_PRESET) {
      return res.status(500).json({
        error: "Missing CLOUDINARY_CLOUD_NAME or CLOUDINARY_UPLOAD_PRESET",
      });
    }

    const { fields, files } = await parseForm(req);

    const uploadedFileRaw = files.file;
    const uploadedFile = Array.isArray(uploadedFileRaw)
      ? uploadedFileRaw[0]
      : uploadedFileRaw;

    if (!uploadedFile) {
      return res.status(400).json({
        error: "Missing file field",
      });
    }

    const folderRaw = fields.folder;
    const publicIdRaw = fields.public_id;

    const folder = Array.isArray(folderRaw)
      ? folderRaw[0]
      : folderRaw || "notion-pdf-crops";

    const publicId = Array.isArray(publicIdRaw)
      ? publicIdRaw[0]
      : publicIdRaw;

    const fileBuffer = fs.readFileSync(uploadedFile.filepath);
    const base64 = fileBuffer.toString("base64");
    const mimeType = uploadedFile.mimetype || "image/png";
    const dataUri = `data:${mimeType};base64,${base64}`;

    const cloudinaryForm = new FormData();
    cloudinaryForm.append("file", dataUri);
    cloudinaryForm.append("upload_preset", UPLOAD_PRESET);
    cloudinaryForm.append("folder", String(folder));

    if (publicId) {
      cloudinaryForm.append("public_id", String(publicId));
    }

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
      {
        method: "POST",
        body: cloudinaryForm,
      }
    );

    const result = await uploadRes.json();

    if (!uploadRes.ok) {
      return res.status(uploadRes.status).json({
        error: "Cloudinary upload failed",
        detail: result,
      });
    }

    return res.status(200).json({
      secure_url: result.secure_url,
      url: result.url,
      public_id: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
    });
  } catch (error) {
    return res.status(500).json({
      error: "FUNCTION_INVOCATION_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
