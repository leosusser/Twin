// This design preview only shows a selected image locally; it never uploads a photo.
const photoInput = document.querySelector('#avatar-photo');
const photoImage = document.querySelector('#photo-preview-image');
const photoPlaceholder = document.querySelector('#photo-placeholder');
const photoActionLabel = document.querySelector('#photo-action-label');
const photoHelp = document.querySelector('#photo-help');
let photoUrl = null;

photoInput.addEventListener('change', () => {
  const file = photoInput.files?.[0];
  if (!file) return;

  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8_000_000) {
    photoHelp.textContent = 'CHOOSE A PNG, JPEG, OR WEBP UNDER 8 MB';
    photoInput.value = '';
    return;
  }

  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(file);
  photoImage.src = photoUrl;
  photoImage.hidden = false;
  photoPlaceholder.hidden = true;
  photoActionLabel.textContent = 'REPLACE PHOTO';
  photoHelp.textContent = 'PHOTO SELECTED · PREVIEW ONLY';
});

window.addEventListener('pagehide', () => {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
});
