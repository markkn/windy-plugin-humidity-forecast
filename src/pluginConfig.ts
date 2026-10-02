import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
  name: 'windy-plugin-humidity-forecast',
  version: '0.1.11',
  icon: '💧',
  title: 'Humidity Forecast',
  description: 'Hourly, 3-hour, and daily high/low humidity forecasts with temperature and dew point.',
  author: 'markkn',
  repository: 'https://github.com/markkn/windy-plugin-humidity-forecast',
  desktopUI: 'rhpane',
  desktopWidth: 560,
  mobileUI: 'fullscreen',
  routerPath: '/humidity-forecast/:lat?/:lon?',
  addToContextmenu: true,
  listenToSingleclick: true,
  private: true,
};

export default config;
