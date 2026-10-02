import * as migration_20261002_181423_owner_news_initial from './20261002_181423_owner_news_initial';

export const migrations = [
  {
    up: migration_20261002_181423_owner_news_initial.up,
    down: migration_20261002_181423_owner_news_initial.down,
    name: '20261002_181423_owner_news_initial'
  },
];
