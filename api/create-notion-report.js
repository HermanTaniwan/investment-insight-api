export default function handler(req, res) {
  return res.status(200).json({
    ok: true,
    method: req.method,
    message: "create-notion-report endpoint is alive",
  });
}
