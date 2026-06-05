# Claude Playground

Статичный сайт-витрина мини-проектов. Главная — `index.html`.

## Деплой на GitHub Pages

GitHub Pages раздаётся из ветки `gh-pages` (без GitHub Actions, классический режим).

**Каждый раз** после внесения и пуша изменений в сайт нужно передеплоить:
обновить ветку `gh-pages` до актуального коммита.

```bash
git push origin <current-branch>:gh-pages
```

Если fast-forward невозможен, сначала разобраться с расхождением, а не делать force-push вслепую.
