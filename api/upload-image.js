export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        method: req.method,
        message: "upload-image endpoint is alive",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (!cloudName || !uploadPreset) {
      return res.status(500).json({
        ok: false,
        error: "Missing CLOUDINARY_CLOUD_NAME or CLOUDINARY_UPLOAD_PRESET",
      });
    }

    let { filename, mime_type, base64, folder, public_id } = req.body || {};

    if (!base64 || !mime_type) {
      return res.status(400).json({
        ok: false,
        error: "Missing base64 or mime_type",
      });
    }

    const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedTypes.includes(mime_type)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid mime_type. Use image/png, image/jpeg, or image/webp.",
      });
    }

    // Clean base64 safely
    base64 = String(base64).trim();

    // If GPT sends full data URI, strip prefix
    if (base64.startsWith("data:")) {
      const commaIndex = base64.indexOf(",");
      if (commaIndex !== -1) {
        base64 = base64.slice(commaIndex + 1);
      }
    }

    // Remove whitespace/newlines
    base64 = base64.replace(/\s/g, "");

    // Basic validation
    if (base64.length < 100) {
      return res.status(400).json({
        ok: false,
        error: "Base64 string too short; likely not a valid image.",
        preview: base64.slice(0, 50),
      });
    }

    const dataUri = `data:${mime_type};base64,${base64}`;

    const cloudinaryForm = new FormData();
    cloudinaryForm.append("file", dataUri);
    cloudinaryForm.append("upload_preset", uploadPreset);
    cloudinaryForm.append("folder", folder || "notion-pdf-crops");

    if (public_id) {
      cloudinaryForm.append("public_id", public_id);
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
        debug: {
          mime_type,
          base64_length: base64.length,
          base64_preview: base64.slice(0, 30),
        },
      });
    }

    return res.status(200).json({
      ok: true,
      filename: filename || null,
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
