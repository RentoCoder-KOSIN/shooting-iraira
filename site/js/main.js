// 遊ぶボタンのリンク先(ゲームのURLができたらここを書き換えます)
const GAME_URL = '/play';

document.addEventListener('DOMContentLoaded', () => {
  const playLink = document.getElementById('play-link');
  if (playLink) playLink.href = GAME_URL;

  // モバイルメニュー: リンクを押したら閉じる
  const nav = document.getElementById('nav');
  document.querySelectorAll('#nav a').forEach((a) => {
    a.addEventListener('click', () => {
      if (nav.classList.contains('show')) {
        bootstrap.Collapse.getOrCreateInstance(nav).hide();
      }
    });
  });
});
