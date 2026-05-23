import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

function parseForm(req) {
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

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "upload-image-file endpoint is alive",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
      });
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (!cloudName || !uploadPreset) {
      return res.status(500).json({
        ok: false,
        error: "Missing CLOUDINARY_CLOUD_NAME or CLOUDINARY_UPLOAD_PRESET",
      });
    }

    const { fields, files } = await parseForm(req);

    const rawFile = files.file;
    const uploadedFile = Array.isArray(rawFile) ? rawFile[0] : rawFile;

    if (!uploadedFile) {
      return res.status(400).json({
        ok: false,
        error: "Missing file field",
      });
    }

    const mimeType = uploadedFile.mimetype || "image/png";

    const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid file type. Use PNG, JPG, or WEBP.",
        mimeType,
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
    const dataUri = `data:${mimeType};base64,${base64}`;

    const cloudinaryForm = new FormData();
    cloudinaryForm.append("file", dataUri);
    cloudinaryForm.append("upload_preset", uploadPreset);
    cloudinaryForm.append("folder", folder);

    if (publicId) {
      cloudinaryForm.append("public_id", publicId);
    }

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      {
        method: "POST",
        body: cloudinaryForm,
      }
    );

    const result = await uploadRes.json();

    if (!uploadRes.ok) {
      return res.status(uploadRes.status).json({
        ok: false,
        error: "Cloudinary upload failed",
        detail: result,
      });
    }

    return res.status(200).json({
      ok: true,
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
      ok: false,
      error: "FUNCTION_INVOCATION_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
