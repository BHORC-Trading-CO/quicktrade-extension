declare global {
  namespace NodeJS {
    interface ProcessEnv {
      CLIENT_URL: string;
      API_URL: string;
      CHROME_EXTENSION_URL: string;
      GOOGLE_ANALYTICS_ID: string;
      CHROME_EXTENSION_ID: string;
    }
  }
}

export {};
