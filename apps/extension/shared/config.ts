import { isDevelopmentMode } from './bridge-policy';

export const BRIDGE_MODE = import.meta.env.MODE;
const isDev = isDevelopmentMode(BRIDGE_MODE);

export const config = {
  mode: isDev ? ('dev' as const) : ('prod' as const),
  frontend_root: isDev ? 'http://localhost:3000' : 'https://app.quicktrade.skin',
  backend_root: isDev ? 'http://localhost:3003/api' : 'https://app.quicktrade.skin/api',
  api_url: isDev ? 'http://localhost:3003/api' : 'https://app.quicktrade.skin/api',
};

export default config;
