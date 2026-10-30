// Date navigation is interactive for the mockup. Activity content remains sample data.
const selectedDate = document.querySelector('#selected-date');
const dayName = selectedDate.querySelector('.day-name');
const dayDate = selectedDate.querySelector('.day-date');
let day = new Date(Date.UTC(2026, 9, 24));

function renderDay() {
  const format = (options) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(day);
  selectedDate.dateTime = day.toISOString().slice(0, 10);
  dayName.textContent = format({ weekday: 'long' }).toUpperCase();
  dayDate.textContent = format({ month: 'long', day: 'numeric' }).toUpperCase();
}

document.querySelectorAll('[data-day-step]').forEach((button) => {
  button.addEventListener('click', () => {
    day.setUTCDate(day.getUTCDate() + Number(button.dataset.dayStep));
    renderDay();
  });
});
