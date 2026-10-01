import { createYouTubePlayer } from './youtube-player.js';
import { createHTML5Player } from './html5-player.js';

/** Each host belongs to one lesson; its aria-label supplies the lesson title. */
export async function createLessonPlayer(options) {
  if (!options?.host?.ownerDocument) throw new TypeError('Container da aula inválido.');
  if (options.signal?.aborted) throw new DOMException('Aula cancelada.', 'AbortError');
  if (options.media?.type === 'youtube') return createYouTubePlayer(options);
  if (options.media?.type === 'file') return createHTML5Player(options);
  throw new TypeError('Formato de vídeo não suportado.');
}
