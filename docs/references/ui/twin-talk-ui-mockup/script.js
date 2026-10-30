// Preserve the mockup page from which TALK was opened.
const source = new URLSearchParams(window.location.search).get('from');
if (source === 'schedule') {
  document.querySelector('.back-button').href = '../twin-schedule-ui-mockup/index.html';
}

// Visual interaction only: this does not request microphone access or record audio.
const screen = document.querySelector('.twin-screen');
const orb = document.querySelector('#orb-toggle');
const status = document.querySelector('#voice-status-text');

function toggleSpeakingPreview() {
  const talking = screen.classList.toggle('talking');
  orb.setAttribute('aria-pressed', String(talking));
  orb.setAttribute('aria-label', talking ? 'Stop talking animation preview' : 'Preview talking animation');
  status.textContent = talking ? "YOU'RE SPEAKING" : 'TAP ORB TO TALK';
}

orb.addEventListener('click', toggleSpeakingPreview);
