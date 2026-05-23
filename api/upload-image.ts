export const config = {
  runtime: "nodejs",
};

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

export default async function handler(req: Request) {
  if (req.method === "GET") {
    return Response.json({
      ok: true,
      message: "upload-image endpoint is alive",
    });
  }

  if (req.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405 }
    );
  }

  if (!CLOUD_NAME || !UPLOAD_PRESET) {
    return Response.json(
      { error: "Missing Cloudinary environment variables" },
      { status: 500 }
    );
  }

  const formData = await req.formData();
  const file = formData.get("file");
  const folder = formData.get("folder")?.toString() || "notion-pdf-crops";
  const publicId = formData.get("public_id")?.toString();

  if (!file || !(file instanceof File)) {
    return Response.json(
      { error: "Missing file. Use multipart/form-data field: file" },
      { status: 400 }
    );
  }

  const cloudinaryForm = new FormData();
  cloudinaryForm.append("file", file);
  cloudinaryForm.append("upload_preset", UPLOAD_PRESET);
  cloudinaryForm.append("folder", folder);

  if (publicId) {
    cloudinaryForm.append("public_id", publicId);
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
    return Response.json(
      {
        error: "Cloudinary upload failed",
        detail: result,
      },
      { status: uploadRes.status }
    );
  }

  return Response.json({
    secure_url: result.secure_url,
    url: result.url,
    public_id: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
  });
}
