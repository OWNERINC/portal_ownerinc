import { fetchAPI } from '../js/auth.js';
import { element } from '../js/ui.js';
import { createPageLifecycle } from '../js/page-lifecycle.js';
import { renderBlocks } from '../js/cms-block-renderer.js';
import { createLessonPlayer } from './player.js';
import { createProgressController } from './progress-controller.js';
import { heading, button, curriculum, routeLink, unavailable } from './view-utils.js';
import { mountAcademyMotion, playCompletion } from './motion.js';

export function lessonView({ root, page, api, navigate, LessonView, CourseView, preview = false, ownerPage = page }) {
  const scope = createPageLifecycle({ user: page.user });
  const abort = () => scope.dispose();
  page.signal.addEventListener('abort', abort, { once: true });
  scope.cleanup(() => page.signal.removeEventListener('abort', abort));
  const lesson = LessonView.lesson;
  let player = null, manual = false, lost = false, checking = false, starting = false;
  const host = element('div', { className: 'academy-player', 'aria-label': lesson.title, 'aria-busy': 'true' });
  const playerStatus = element('div', { className: 'academy-player-status' }, [element('p', { role: 'status', text: 'Carregando vídeo…' })]);
  const status = element('p', { role: 'status', className: 'academy-save-status' });
  const materials = element('div', { className: 'academy-materials cms-public-content' });
  const actions = element('div', { className: 'academy-actions' });
  const next = LessonView.next_lesson_id ? routeLink('Próxima aula →',
    { course: CourseView.course.id, lesson: LessonView.next_lesson_id, ...(preview ? { preview: '1' } : {}) }, navigate) : null;
  const complete = button(LessonView.progress.completed ? 'Aula concluída' : 'Concluir aula', saveCompletion);
  complete.setAttribute('data-motion-completion', '');
  complete.disabled = LessonView.progress.completed || preview;
  actions.append(complete);
  if (next) { next.hidden = !LessonView.progress.completed; actions.append(next); }
  const main = element('section', { className: 'academy-lesson-main' }, [host, playerStatus, heading(lesson.title), actions, status, materials]);
  const details = element('details', { className: 'academy-curriculum-disclosure', open: true }, [
    element('summary', { text: 'Conteúdo do curso' }), curriculum(CourseView, navigate, lesson.id, preview),
  ]);
  root.replaceChildren(routeLink('← Voltar ao curso', { course: CourseView.course.id, ...(preview ? { preview: '1' } : {}) }, navigate),
    element('div', { className: 'academy-classroom' }, [main, details]));
  renderBlocks(materials, LessonView.content_blocks, { fallbackText: LessonView.description || '', signal: scope.signal });

  function revoke() {
    if (lost || !scope.active) return;
    lost = true;
    scope.dispose(); player?.destroy(); player = null;
    host.replaceChildren(); materials.replaceChildren(); details.replaceChildren(); actions.replaceChildren();
    host.setAttribute('aria-busy', 'false'); playerStatus.replaceChildren();
    status.textContent = unavailable;
  }
  const progress = createProgressController({ lessonId: lesson.id, initial: LessonView.progress,
    request: fetchAPI, signal: scope.signal,
    onStatus(state, detail) {
      if (!scope.active) return;
      if (state === 'unavailable' && [401, 403, 404].includes(detail?.status)) { revoke(); return; }
      status.textContent = ({ saving: 'Salvando progresso…', saved: 'Progresso salvo.', pending: 'Progresso aguardando sincronização.',
        conflict: 'O progresso ou o vídeo mudou. Recarregue a aula para continuar.', unavailable: 'Não foi possível salvar o progresso.' })[state] || '';
      if (state === 'conflict') {
        complete.disabled = true;
        actions.append(button('Recarregar aula', () => navigate(Object.fromEntries(new URL(page.location.href).searchParams))));
      }
    },
  });
  scope.cleanup(() => { player?.destroy(); progress.dispose(); });
  if (typeof mountAcademyMotion === 'function') scope.cleanup(mountAcademyMotion(main, { signal: scope.signal }));
  // Only the explicit action participates in the Portal's mutation/leave guard.
  // Background controller writes retain their own signal and original fetchAPI.
  const manualAPI = ownerPage.bindAPI({ complete: () => progress.complete() });
  async function saveCompletion() {
    if (manual || lost || preview || !scope.active) return;
    manual = true; complete.disabled = true;
    try {
      progress.record(player?.getPosition() ?? LessonView.progress.position_seconds);
      const ack = await manualAPI.complete(`/api/academy/lessons/${encodeURIComponent(lesson.id)}/progress`, { method: 'PUT', signal: scope.signal });
      if (!scope.active) return;
      // A generic flush may return without writing during backoff. Never infer success.
      if (ack.lesson_id !== lesson.id || ack.media_version !== LessonView.progress.media_version || ack.completed !== true) {
        throw new Error('Conclusão não confirmada.');
      }
      complete.textContent = 'Aula concluída';
      status.textContent = 'Aula concluída. Seu progresso foi salvo.';
      const link = details.querySelector('[aria-current="page"]');
      if (link) link.textContent = `${lesson.title} · Concluída`;
      if (next) next.hidden = false;
      if (typeof playCompletion === 'function') playCompletion(main);
    } catch (error) {
      if (!scope.active) return;
      if ([401, 403, 404].includes(error.status)) { revoke(); return; }
      status.textContent = error.status === 409 ? 'O progresso ou o vídeo mudou. Recarregue a aula para continuar.'
        : 'Não foi possível concluir a aula. Tente novamente.';
      complete.disabled = error.status === 409;
    } finally { manual = false; }
  }
  async function startPlayer() {
    if (!scope.active || starting) return;
    starting = true;
    playerStatus.replaceChildren(element('p', { role: 'status', text: 'Carregando vídeo…' }));
    host.setAttribute('aria-busy', 'true');
    try {
      player = await createLessonPlayer({ host, media: LessonView.media, startSeconds: LessonView.progress.position_seconds, signal: scope.signal,
        onPosition: seconds => { if (!preview) progress.record(seconds); },
        onPause: () => { if (!preview) progress.flush().catch(() => {}); },
        onEnded: () => { if (scope.active) status.textContent = 'Vídeo finalizado. Use Concluir aula para registrar a conclusão.'; },
        onError: showPlayerError,
      });
      if (!scope.active) { player.destroy(); return; }
      playerStatus.replaceChildren(); host.setAttribute('aria-busy', 'false');
    } catch (error) { if (error.name !== 'AbortError') showPlayerError(error); }
    finally { starting = false; }
  }
  function showPlayerError(error) {
    if (!scope.active) return;
    player?.destroy(); player = null;
    host.setAttribute('aria-busy', 'false');
    playerStatus.replaceChildren(element('p', { role: 'status', text: error.message || 'Não foi possível reproduzir este vídeo.' }), button('Tentar novamente', startPlayer));
  }
  scope.listen(window, 'focus', async () => {
    if (checking || lost) return;
    checking = true;
    try {
      const fresh = await api.lesson(lesson.id, preview);
      if (!scope.active) return;
      if (fresh.course_id !== CourseView.course.id || fresh.lesson.media_version !== lesson.media_version) {
        revoke(); status.textContent = 'Esta aula mudou. Volte ao curso para recarregar o conteúdo.';
      }
    } catch (error) {
      if (!scope.active) return;
      if ([401, 403, 404].includes(error.status)) revoke();
      else status.textContent = 'Não foi possível verificar o acesso. Verifique sua conexão.';
    } finally { checking = false; }
  });
  if (preview) status.textContent = 'Prévia editorial · o progresso não é salvo.';
  startPlayer();
  return {
    async beforeNavigate() {
      if (manual) return false;
      if (!scope.active || preview) return true;
      player?.pause();
      progress.record(player?.getPosition() ?? LessonView.progress.position_seconds);
      try { await progress.flush(); }
      catch { if (scope.active) ownerPage.toast('A última posição confirmada foi mantida; a posição recente não foi salva.'); }
      return true;
    },
    dispose() { scope.dispose(); },
  };
}
