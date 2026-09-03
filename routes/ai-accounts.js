export function register(ctx) {
  const { addRoute, json, listAiAccounts } = ctx;

  addRoute('GET', '/api/ai-accounts', (_req, res) => {
    try { json(res, listAiAccounts()); }
    catch { json(res, { error: 'AI 계정 정보를 불러오지 못했습니다.' }, 500); }
  });
}
