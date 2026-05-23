export const runtime = "nodejs";

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

export async function POST(req: Request) {
  try {
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
        { error: "Missing file. Send multipart/form-data with field name 'file'." },
        { status: 400 }
      );
    }

    const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      return Response.json(
        { error: "Invalid file type. Only PNG, JPG, and WEBP are allowed." },
        { status: 400 }
      );
    }

    const maxSizeMb = 8;
    if (file.size > maxSizeMb * 1024 * 1024) {
      return Response.json(
        { error: `File too large. Max ${maxSizeMb}MB.` },
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
  } catch (error) {
    return Response.json(
      {
        error: "Unexpected server error",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
