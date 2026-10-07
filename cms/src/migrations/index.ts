import * as migration_20261002_181423_owner_news_initial from './20261002_181423_owner_news_initial';
import * as migration_20261005_133515_owner_news_media from './20261005_133515_owner_news_media';
import * as migration_20261005_151541_owner_news_publication from './20261005_151541_owner_news_publication';
import * as migration_20261005_220916_owner_news_legacy_history from './20261005_220916_owner_news_legacy_history';
import * as migration_20261006_181325_a_owner_news_suspend_enum from './20261006_181325_a_owner_news_suspend_enum';
import * as migration_20261006_181424_z_owner_news_native from './20261006_181424_z_owner_news_native';

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
    name: '20261005_151541_owner_news_publication',
  },
  {
    up: migration_20261005_220916_owner_news_legacy_history.up,
    down: migration_20261005_220916_owner_news_legacy_history.down,
    name: '20261005_220916_owner_news_legacy_history',
  },
  {
    up: migration_20261006_181325_a_owner_news_suspend_enum.up,
    down: migration_20261006_181325_a_owner_news_suspend_enum.down,
    name: '20261006_181325_a_owner_news_suspend_enum',
  },
  {
    up: migration_20261006_181424_z_owner_news_native.up,
    down: migration_20261006_181424_z_owner_news_native.down,
    name: '20261006_181424_z_owner_news_native'
  },
];
