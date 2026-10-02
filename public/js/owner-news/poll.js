import { fetchAPI } from '../auth.js';
import { element } from '../ui.js';

export function createNewsPoll({ page, poll }) {
  const api = page.bindAPI({ fetchAPI }).fetchAPI;
  const controller = new AbortController();
  const node = element('article', { className: 'news-poll' });
  const title = element('p', { className: 'news-poll-title' });
  const question = element('h2');
  const description = element('p');
  const options = element('div', { className: 'news-poll-options' });
  const total = element('p');
  const status = element('p', { role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const verify = element('button', { type: 'button', className: 'news-poll-verify', text: 'Verificar meu voto' });
  node.append(title, question, description, options, total, status, verify);
  let current = poll, submitting = false, disposed = false, pendingOptionId = null, message = '';
  const bindings = [];
  const bind = (target, action) => {
    target.addEventListener('click', action);
    bindings.push(() => target.removeEventListener('click', action));
  };
  // Published options are immutable. Keep their DOM identity through submission.
  const choices = poll.options.map(option => {
    const label = element('span');
    const percent = element('span', { className: 'news-poll-percentage' });
    const bar = element('span', { className: 'news-poll-option-bar', 'aria-hidden': 'true' });
    const button = element('button', { type: 'button', className: 'news-poll-option' }, [bar, label, percent]);
    bind(button, () => { void vote(option.id); });
    options.append(button);
    return { id: option.id, button, label, percent, bar };
  });
  bind(verify, () => { void verifyVote(); });

  function adopt(next) {
    if (disposed || !next || next.id !== current.id || next.version < current.version) return;
    // A current GET begun before the POST may arrive after its confirmation.
    if (current.viewer_option_id && next.viewer_option_id !== current.viewer_option_id) return;
    if (current.status === 'closed' && next.status !== 'closed') return;
    current = next;
    if (current.viewer_option_id || current.status !== 'open') pendingOptionId = null;
    return true;
  }

  function render() {
    if (disposed) return;
    const hadFocus = node.contains(document.activeElement);
    title.textContent = current.title;
    question.textContent = current.question;
    description.textContent = current.description || '';
    description.hidden = !current.description;
    node.setAttribute('aria-busy', String(submitting));
    const locked = current.status !== 'open' || Boolean(current.viewer_option_id);
    choices.forEach(choice => {
      const option = current.options.find(value => value.id === choice.id);
      const percentage = typeof option?.percentage === 'number' && Number.isFinite(option.percentage)
        && option.percentage >= 0 && option.percentage <= 100 ? option.percentage : 0;
      const selected = current.viewer_option_id === choice.id;
      choice.label.textContent = `${option?.label || ''}${selected ? ' — Sua escolha' : pendingOptionId === choice.id && !submitting ? ' — Reenviar esta escolha' : ''}`;
      choice.percent.textContent = `${percentage}%`;
      choice.bar.style.width = `${percentage}%`;
      choice.button.setAttribute('aria-pressed', String(selected));
      choice.button.disabled = submitting || locked || Boolean(pendingOptionId && pendingOptionId !== choice.id);
    });
    total.textContent = current.total_votes ? `${current.total_votes} voto${current.total_votes === 1 ? '' : 's'}` : 'Seja a primeira pessoa a participar';
    status.textContent = submitting ? 'Verificando seu voto…' : current.viewer_option_id
      ? current.closing || 'Obrigada por participar.' : current.status !== 'open'
        ? 'Esta enquete foi encerrada.' : message;
    verify.hidden = !pendingOptionId || locked;
    verify.disabled = submitting || locked || !pendingOptionId;
    // Keep focus in a stable live node when the active button becomes disabled.
    if (hadFocus && (locked || document.activeElement?.disabled)) status.focus();
  }

  async function reconcile() {
    adopt(await api(`/api/announcements/polls/${encodeURIComponent(current.id)}`, { signal: controller.signal }));
    // An empty GET cannot rule out a late commit: retain pendingOptionId.
  }

  async function verifyVote() {
    if (disposed || submitting || !pendingOptionId) return;
    submitting = true; render();
    try {
      await reconcile();
      message = 'Seu voto ainda não foi confirmado. Verifique novamente ou reenvie a mesma escolha.';
    } catch (error) {
      if (!disposed && error.name !== 'AbortError') message = 'Ainda não foi possível verificar seu voto.';
    } finally { submitting = false; render(); }
  }

  async function vote(optionId) {
    if (disposed || submitting || current.status !== 'open' || current.viewer_option_id
      || (pendingOptionId && pendingOptionId !== optionId)) return;
    pendingOptionId = optionId; submitting = true; render();
    try {
      adopt(await api(`/api/announcements/polls/${encodeURIComponent(current.id)}/votes`, {
        method: 'POST', body: JSON.stringify({ option_id: optionId }), signal: controller.signal,
      }));
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      // APIError exposes reason, not a PollDTO. Even 409 must reconcile by GET.
      message = 'Seu voto ainda não foi confirmado. Verifique o resultado ou reenvie a mesma escolha.';
      try { await reconcile(); }
      catch (refreshError) {
        if (!disposed && refreshError.name !== 'AbortError') message = 'Seu voto ainda não foi confirmado. Tente verificar novamente.';
      }
    } finally { submitting = false; render(); }
  }

  function dispose() {
    if (disposed) return;
    disposed = true; controller.abort(); bindings.forEach(unbind => unbind());
  }
  page.cleanup(dispose);
  render();
  return { node, update(next) { if (adopt(next)) render(); }, dispose };
}
