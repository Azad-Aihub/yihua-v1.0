// 一画 · EdgeOne Pages：/admin → /admin.html 跳转兜底
export async function onRequest(context) {
  const url = new URL(context.request.url);
  return Response.redirect(new URL("/admin.html", url).toString(), 307);
}
