import type { APIRequestContext } from '@playwright/test';

export async function command(request: APIRequestContext, action: 'claim' | 'start') {
  const origin = 'http://127.0.0.1:8090';
  const { capability } = await (await request.get(origin + '/session')).json();
  return request.post(origin + '/' + action, {
    headers: { 'content-type': 'application/json', 'x-natcut-control': capability },
  });
}
