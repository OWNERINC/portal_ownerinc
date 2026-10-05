import * as migration_20261002_181423_owner_news_initial from './20261002_181423_owner_news_initial';
import * as migration_20261005_133515_owner_news_media from './20261005_133515_owner_news_media';
import * as migration_20261005_151541_owner_news_publication from './20261005_151541_owner_news_publication';

export const migrations = [
  {
    up: migration_20261002_181423_owner_news_initial.up,
    down: migration_20261002_181423_owner_news_initial.down,
    name: '20261002_181423_owner_news_initial',
  },
  {
    up: migration_20261005_133515_owner_news_media.up,
    down: migration_20261005_133515_owner_news_media.down,
    name: '20261005_133515_owner_news_media',
  },
  {
    up: migration_20261005_151541_owner_news_publication.up,
    down: migration_20261005_151541_owner_news_publication.down,
    name: '20261005_151541_owner_news_publication'
  },
];
