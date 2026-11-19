export default {
  fetch: (request: Request) => {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      path: url.pathname,
      hasDbUrl: Boolean(process.env.DATABASE_URL),
      node: process.version,
    });
  },
};
