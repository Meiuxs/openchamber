# Prompt Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Enhance prompt button to the chat composer that rewrites the current draft in place, with a strict provider boundary, reference preservation and undo.

**Architecture:** A new `promptEnhancement` module owns prompt rendering, the Small Model pre-flight, the OpenCode fallback, output normalization and the reference guard. The composer gets a button in `ComposerFooter` and a handler in `ChatInput`. Defaults are editable through two new Magic Prompts. Web and Electron use the Small Model; the VS Code extension-only runtime uses `opencodeClient.generateText` with the current model. Mobile is untouched.

**Tech Stack:** TypeScript, React, CodeMirror 6, Zustand, Bun test, Happy DOM, Sonner toasts, Magic Prompts, Small Model, OpenCode SDK.

**Spec:** `docs/superpowers/specs/2026-11-14-prompt-enhancement-design.md`

## Global Constraints

- Do not modify `../opencode`.
- Do not run git or GitHub commands unless the user explicitly asks. The commit steps below run only under that permission; otherwise hand off the working tree.
- Do not add dependencies.
- Web browser, Electron and the VS Code extension-only runtime are in scope. Mobile is out of scope and its footer must stay unchanged.
- The feature is pinned to the composer's current provider. A Small Model override naming another provider is not used.
- The 20-second timeout aborts both transports.
- Protect `@token`, `$name`, `#token`, URLs, code fences and attachment citations.
- All 15 locales get the new keys.
- No new server route, no OpenCode change, no VS Code small-model bridge.
- `changelog/` is read-only.
- UI tests run with `bun test <path>`. `mock.module` is process-global, so run mock-heavy files alone.
- Before any commit, `bun run check:changed --base HEAD` passes.

## Review Focus

1. A draft changed while the request is in flight. The user's newer text must win and the enhanced result must be dropped. Tested in Task 6.
2. A rewrite that drops a file, skill, snippet, URL, fence or attachment citation. The original draft must be kept. Tested in Tasks 4a and 6.
3. The Small Model resolving to another provider. The draft must not leave the current provider. Tested in Task 4b.
4. An isolated-space draft routed to the host OpenCode. The request must carry the space directory in body and fetch options. Tested in Task 4b.
5. A request that hangs. It must abort at 20 seconds and leave the draft unchanged. Tested in Task 4b.

---

### Task 1: Prompt enhancement i18n

**Files:**
- Create: `packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.ts`
- Create: `packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.test.ts`
- Modify: `packages/ui/src/lib/i18n/messages/en.ts`
- Modify: `packages/ui/src/lib/i18n/messages/de.ts`
- Modify: `packages/ui/src/lib/i18n/messages/fr.ts`
- Modify: `packages/ui/src/lib/i18n/messages/nl.ts`
- Modify: `packages/ui/src/lib/i18n/messages/es.ts`
- Modify: `packages/ui/src/lib/i18n/messages/ja.ts`
- Modify: `packages/ui/src/lib/i18n/messages/pt-BR.ts`
- Modify: `packages/ui/src/lib/i18n/messages/uk.ts`
- Modify: `packages/ui/src/lib/i18n/messages/ko.ts`
- Modify: `packages/ui/src/lib/i18n/messages/pl.ts`
- Modify: `packages/ui/src/lib/i18n/messages/zh-CN.ts`
- Modify: `packages/ui/src/lib/i18n/messages/zh-TW.ts`
- Modify: `packages/ui/src/lib/i18n/messages/tr.ts`
- Modify: `packages/ui/src/lib/i18n/messages/ar.ts`
- Modify: `packages/ui/src/lib/i18n/messages/he.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `promptEnhancementI18n` with an entry for every locale listed in `LOCALES`. Keys used by later tasks: `chat.chatInput.actions.enhancePrompt`, `chat.chatInput.actions.undo`, `chat.chatInput.toast.enhanceSuccess`, `chat.chatInput.toast.enhanceNoChange`, `chat.chatInput.toast.enhanceFailed`, `chat.chatInput.toast.enhanceTimeout`, `chat.chatInput.toast.enhanceDraftChanged`, `chat.chatInput.toast.enhanceReferencesChanged`, `chat.chatInput.enhancePrompt.disabledNoText`, `settings.magicPrompts.page.group.promptEnhance.title`, `settings.magicPrompts.page.group.promptEnhance.description`, `settings.magicPrompts.sidebar.item.promptEnhance`.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { promptEnhancementI18n } from './prompt-enhancement.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('prompt enhancement translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(promptEnhancementI18n.en);
    const dictionaries: Record<string, Record<string, string>> = promptEnhancementI18n;
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(dictionaries[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.test.ts`

Expected: FAIL because `./prompt-enhancement.i18n` does not exist.

- [ ] **Step 3: Write the feature dictionary**

Create `packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.ts`:

```ts
/** Prompt enhancement strings, merged into each locale's main dictionary. */
export const promptEnhancementI18n = {
  en: {
    'chat.chatInput.actions.enhancePrompt': 'Enhance prompt',
    'chat.chatInput.actions.undo': 'Undo',
    'chat.chatInput.toast.enhanceSuccess': 'Prompt enhanced',
    'chat.chatInput.toast.enhanceNoChange': 'This prompt is already clear',
    'chat.chatInput.toast.enhanceFailed': 'Could not enhance the prompt',
    'chat.chatInput.toast.enhanceTimeout': 'Enhancing the prompt timed out',
    'chat.chatInput.toast.enhanceDraftChanged': 'The draft changed, so the enhanced version was not applied',
    'chat.chatInput.toast.enhanceReferencesChanged': 'The enhanced version changed your references, so the original draft was kept',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Type a prompt first',
    'settings.magicPrompts.page.group.promptEnhance.title': 'Prompt Enhancement',
    'settings.magicPrompts.page.group.promptEnhance.description': 'The prompt used to rewrite a composer draft before sending.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'Prompt Enhancement',
  },
  de: {
    'chat.chatInput.actions.enhancePrompt': 'Prompt verbessern',
    'chat.chatInput.actions.undo': 'Rückgängig',
    'chat.chatInput.toast.enhanceSuccess': 'Prompt verbessert',
    'chat.chatInput.toast.enhanceNoChange': 'Dieser Prompt ist bereits klar',
    'chat.chatInput.toast.enhanceFailed': 'Der Prompt konnte nicht verbessert werden',
    'chat.chatInput.toast.enhanceTimeout': 'Zeitüberschreitung beim Verbessern des Prompts',
    'chat.chatInput.toast.enhanceDraftChanged': 'Der Entwurf wurde geändert, daher wurde die verbesserte Version nicht übernommen',
    'chat.chatInput.toast.enhanceReferencesChanged': 'Die verbesserte Version hat deine Verweise geändert, daher wurde der ursprüngliche Entwurf behalten',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Gib zuerst einen Prompt ein',
    'settings.magicPrompts.page.group.promptEnhance.title': 'Prompt-Verbesserung',
    'settings.magicPrompts.page.group.promptEnhance.description': 'Der Prompt, mit dem ein Composer-Entwurf vor dem Senden umgeschrieben wird.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'Prompt-Verbesserung',
  },
  fr: {
    'chat.chatInput.actions.enhancePrompt': 'Améliorer le prompt',
    'chat.chatInput.actions.undo': 'Annuler',
    'chat.chatInput.toast.enhanceSuccess': 'Prompt amélioré',
    'chat.chatInput.toast.enhanceNoChange': 'Ce prompt est déjà clair',
    'chat.chatInput.toast.enhanceFailed': 'Impossible d’améliorer le prompt',
    'chat.chatInput.toast.enhanceTimeout': 'L’amélioration du prompt a expiré',
    'chat.chatInput.toast.enhanceDraftChanged': 'Le brouillon a changé, la version améliorée n’a donc pas été appliquée',
    'chat.chatInput.toast.enhanceReferencesChanged': 'La version améliorée a modifié vos références, le brouillon d’origine a donc été conservé',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Saisissez d’abord un prompt',
    'settings.magicPrompts.page.group.promptEnhance.title': 'Amélioration du prompt',
    'settings.magicPrompts.page.group.promptEnhance.description': 'Le prompt utilisé pour réécrire un brouillon du composeur avant l’envoi.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'Amélioration du prompt',
  },
  nl: {
    'chat.chatInput.actions.enhancePrompt': 'Prompt verbeteren',
    'chat.chatInput.actions.undo': 'Ongedaan maken',
    'chat.chatInput.toast.enhanceSuccess': 'Prompt verbeterd',
    'chat.chatInput.toast.enhanceNoChange': 'Deze prompt is al duidelijk',
    'chat.chatInput.toast.enhanceFailed': 'De prompt kon niet worden verbeterd',
    'chat.chatInput.toast.enhanceTimeout': 'Het verbeteren van de prompt is verlopen',
    'chat.chatInput.toast.enhanceDraftChanged': 'De tekst is gewijzigd, dus de verbeterde versie is niet toegepast',
    'chat.chatInput.toast.enhanceReferencesChanged': 'De verbeterde versie heeft je verwijzingen gewijzigd, dus de oorspronkelijke tekst is behouden',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Typ eerst een prompt',
    'settings.magicPrompts.page.group.promptEnhance.title': 'Promptverbetering',
    'settings.magicPrompts.page.group.promptEnhance.description': 'De prompt waarmee een concept van de componist vóór verzending wordt herschreven.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'Promptverbetering',
  },
  es: {
    'chat.chatInput.actions.enhancePrompt': 'Mejorar el prompt',
    'chat.chatInput.actions.undo': 'Deshacer',
    'chat.chatInput.toast.enhanceSuccess': 'Prompt mejorado',
    'chat.chatInput.toast.enhanceNoChange': 'Este prompt ya es claro',
    'chat.chatInput.toast.enhanceFailed': 'No se pudo mejorar el prompt',
    'chat.chatInput.toast.enhanceTimeout': 'Se agotó el tiempo para mejorar el prompt',
    'chat.chatInput.toast.enhanceDraftChanged': 'El borrador cambió, así que no se aplicó la versión mejorada',
    'chat.chatInput.toast.enhanceReferencesChanged': 'La versión mejorada cambió tus referencias, así que se conservó el borrador original',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Escribe primero un prompt',
    'settings.magicPrompts.page.group.promptEnhance.title': 'Mejora de prompt',
    'settings.magicPrompts.page.group.promptEnhance.description': 'El prompt que se usa para reescribir un borrador del compositor antes de enviarlo.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'Mejora de prompt',
  },
  ja: {
    'chat.chatInput.actions.enhancePrompt': 'プロンプトを改善',
    'chat.chatInput.actions.undo': '元に戻す',
    'chat.chatInput.toast.enhanceSuccess': 'プロンプトを改善しました',
    'chat.chatInput.toast.enhanceNoChange': 'このプロンプトはすでに明確です',
    'chat.chatInput.toast.enhanceFailed': 'プロンプトを改善できませんでした',
    'chat.chatInput.toast.enhanceTimeout': 'プロンプトの改善がタイムアウトしました',
    'chat.chatInput.toast.enhanceDraftChanged': '下書きが変更されたため、改善版は適用されませんでした',
    'chat.chatInput.toast.enhanceReferencesChanged': '改善版で参照が変更されたため、元の下書きを保持しました',
    'chat.chatInput.enhancePrompt.disabledNoText': '先にプロンプトを入力してください',
    'settings.magicPrompts.page.group.promptEnhance.title': 'プロンプト改善',
    'settings.magicPrompts.page.group.promptEnhance.description': '送信前にコンポーザーの下書きを書き換えるためのプロンプト。',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'プロンプト改善',
  },
  'pt-BR': {
    'chat.chatInput.actions.enhancePrompt': 'Melhorar prompt',
    'chat.chatInput.actions.undo': 'Desfazer',
    'chat.chatInput.toast.enhanceSuccess': 'Prompt melhorado',
    'chat.chatInput.toast.enhanceNoChange': 'Este prompt já está claro',
    'chat.chatInput.toast.enhanceFailed': 'Não foi possível melhorar o prompt',
    'chat.chatInput.toast.enhanceTimeout': 'A melhoria do prompt expirou',
    'chat.chatInput.toast.enhanceDraftChanged': 'O rascunho mudou, então a versão melhorada não foi aplicada',
    'chat.chatInput.toast.enhanceReferencesChanged': 'A versão melhorada alterou suas referências, então o rascunho original foi mantido',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Digite um prompt primeiro',
    'settings.magicPrompts.page.group.promptEnhance.title': 'Melhoria de prompt',
    'settings.magicPrompts.page.group.promptEnhance.description': 'O prompt usado para reescrever um rascunho do compositor antes do envio.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'Melhoria de prompt',
  },
  uk: {
    'chat.chatInput.actions.enhancePrompt': 'Покращити промпт',
    'chat.chatInput.actions.undo': 'Скасувати',
    'chat.chatInput.toast.enhanceSuccess': 'Промпт покращено',
    'chat.chatInput.toast.enhanceNoChange': 'Цей промпт уже чіткий',
    'chat.chatInput.toast.enhanceFailed': 'Не вдалося покращити промпт',
    'chat.chatInput.toast.enhanceTimeout': 'Час на покращення промпту вичерпано',
    'chat.chatInput.toast.enhanceDraftChanged': 'Чернетку змінено, тому покращену версію не застосовано',
    'chat.chatInput.toast.enhanceReferencesChanged': 'Покращена версія змінила ваші посилання, тому початкову чернетку збережено',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Спочатку введіть промпт',
    'settings.magicPrompts.page.group.promptEnhance.title': 'Покращення промпту',
    'settings.magicPrompts.page.group.promptEnhance.description': 'Промпт, який використовується для переписування чернетки композера перед надсиланням.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'Покращення промпту',
  },
  ko: {
    'chat.chatInput.actions.enhancePrompt': '프롬프트 개선',
    'chat.chatInput.actions.undo': '실행 취소',
    'chat.chatInput.toast.enhanceSuccess': '프롬프트가 개선되었습니다',
    'chat.chatInput.toast.enhanceNoChange': '이 프롬프트는 이미 명확합니다',
    'chat.chatInput.toast.enhanceFailed': '프롬프트를 개선할 수 없습니다',
    'chat.chatInput.toast.enhanceTimeout': '프롬프트 개선 시간이 초과되었습니다',
    'chat.chatInput.toast.enhanceDraftChanged': '초안이 변경되어 개선된 버전을 적용하지 않았습니다',
    'chat.chatInput.toast.enhanceReferencesChanged': '개선된 버전에서 참조가 변경되어 원본 초안을 유지했습니다',
    'chat.chatInput.enhancePrompt.disabledNoText': '먼저 프롬프트를 입력하세요',
    'settings.magicPrompts.page.group.promptEnhance.title': '프롬프트 개선',
    'settings.magicPrompts.page.group.promptEnhance.description': '전송 전에 작성기 초안을 다시 작성하는 데 사용되는 프롬프트입니다.',
    'settings.magicPrompts.sidebar.item.promptEnhance': '프롬프트 개선',
  },
  pl: {
    'chat.chatInput.actions.enhancePrompt': 'Ulepsz prompt',
    'chat.chatInput.actions.undo': 'Cofnij',
    'chat.chatInput.toast.enhanceSuccess': 'Prompt ulepszony',
    'chat.chatInput.toast.enhanceNoChange': 'Ten prompt jest już jasny',
    'chat.chatInput.toast.enhanceFailed': 'Nie udało się ulepszyć promptu',
    'chat.chatInput.toast.enhanceTimeout': 'Przekroczono czas ulepszania promptu',
    'chat.chatInput.toast.enhanceDraftChanged': 'Szkic został zmieniony, więc ulepszona wersja nie została zastosowana',
    'chat.chatInput.toast.enhanceReferencesChanged': 'Ulepszona wersja zmieniła odwołania, więc zachowano oryginalny szkic',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Najpierw wpisz prompt',
    'settings.magicPrompts.page.group.promptEnhance.title': 'Ulepszanie promptu',
    'settings.magicPrompts.page.group.promptEnhance.description': 'Prompt używany do przepisania szkicu w kompozytorze przed wysłaniem.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'Ulepszanie promptu',
  },
  'zh-CN': {
    'chat.chatInput.actions.enhancePrompt': '增强提示词',
    'chat.chatInput.actions.undo': '撤销',
    'chat.chatInput.toast.enhanceSuccess': '提示词已增强',
    'chat.chatInput.toast.enhanceNoChange': '这段提示词已经足够清楚',
    'chat.chatInput.toast.enhanceFailed': '无法增强提示词',
    'chat.chatInput.toast.enhanceTimeout': '增强提示词超时',
    'chat.chatInput.toast.enhanceDraftChanged': '草稿已变化，增强版本未应用',
    'chat.chatInput.toast.enhanceReferencesChanged': '增强版本改动了你的引用，已保留原草稿',
    'chat.chatInput.enhancePrompt.disabledNoText': '请先输入提示词',
    'settings.magicPrompts.page.group.promptEnhance.title': '提示词增强',
    'settings.magicPrompts.page.group.promptEnhance.description': '发送前用来重写输入框草稿的提示词。',
    'settings.magicPrompts.sidebar.item.promptEnhance': '提示词增强',
  },
  'zh-TW': {
    'chat.chatInput.actions.enhancePrompt': '增強提示詞',
    'chat.chatInput.actions.undo': '復原',
    'chat.chatInput.toast.enhanceSuccess': '提示詞已增強',
    'chat.chatInput.toast.enhanceNoChange': '這段提示詞已經夠清楚',
    'chat.chatInput.toast.enhanceFailed': '無法增強提示詞',
    'chat.chatInput.toast.enhanceTimeout': '增強提示詞逾時',
    'chat.chatInput.toast.enhanceDraftChanged': '草稿已變更，增強版本未套用',
    'chat.chatInput.toast.enhanceReferencesChanged': '增強版本改動了你的參照，已保留原草稿',
    'chat.chatInput.enhancePrompt.disabledNoText': '請先輸入提示詞',
    'settings.magicPrompts.page.group.promptEnhance.title': '提示詞增強',
    'settings.magicPrompts.page.group.promptEnhance.description': '傳送前用來改寫輸入框草稿的提示詞。',
    'settings.magicPrompts.sidebar.item.promptEnhance': '提示詞增強',
  },
  tr: {
    'chat.chatInput.actions.enhancePrompt': 'İstemi geliştir',
    'chat.chatInput.actions.undo': 'Geri al',
    'chat.chatInput.toast.enhanceSuccess': 'İstem geliştirildi',
    'chat.chatInput.toast.enhanceNoChange': 'Bu istem zaten açık',
    'chat.chatInput.toast.enhanceFailed': 'İstem geliştirilemedi',
    'chat.chatInput.toast.enhanceTimeout': 'İstemi geliştirme zaman aşımına uğradı',
    'chat.chatInput.toast.enhanceDraftChanged': 'Taslak değişti, bu yüzden geliştirilmiş sürüm uygulanmadı',
    'chat.chatInput.toast.enhanceReferencesChanged': 'Geliştirilmiş sürüm başvurularınızı değiştirdi, bu yüzden özgün taslak korundu',
    'chat.chatInput.enhancePrompt.disabledNoText': 'Önce bir istem yazın',
    'settings.magicPrompts.page.group.promptEnhance.title': 'İstem geliştirme',
    'settings.magicPrompts.page.group.promptEnhance.description': 'Göndermeden önce besteci taslağını yeniden yazmak için kullanılan istem.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'İstem geliştirme',
  },
  ar: {
    'chat.chatInput.actions.enhancePrompt': 'تحسين الموجه',
    'chat.chatInput.actions.undo': 'تراجع',
    'chat.chatInput.toast.enhanceSuccess': 'تم تحسين الموجه',
    'chat.chatInput.toast.enhanceNoChange': 'هذا الموجه واضح بالفعل',
    'chat.chatInput.toast.enhanceFailed': 'تعذر تحسين الموجه',
    'chat.chatInput.toast.enhanceTimeout': 'انتهت مهلة تحسين الموجه',
    'chat.chatInput.toast.enhanceDraftChanged': 'تغيرت المسودة، لذلك لم يتم تطبيق النسخة المحسنة',
    'chat.chatInput.toast.enhanceReferencesChanged': 'غيرت النسخة المحسنة مراجعك، لذلك تم الاحتفاظ بالمسودة الأصلية',
    'chat.chatInput.enhancePrompt.disabledNoText': 'اكتب موجهًا أولًا',
    'settings.magicPrompts.page.group.promptEnhance.title': 'تحسين الموجه',
    'settings.magicPrompts.page.group.promptEnhance.description': 'الموجه المستخدم لإعادة كتابة مسودة المحرر قبل الإرسال.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'تحسين الموجه',
  },
  he: {
    'chat.chatInput.actions.enhancePrompt': 'שפר פרומפט',
    'chat.chatInput.actions.undo': 'בטל',
    'chat.chatInput.toast.enhanceSuccess': 'הפרומפט שופר',
    'chat.chatInput.toast.enhanceNoChange': 'הפרומפט הזה כבר ברור',
    'chat.chatInput.toast.enhanceFailed': 'לא ניתן היה לשפר את הפרומפט',
    'chat.chatInput.toast.enhanceTimeout': 'פג הזמן לשיפור הפרומפט',
    'chat.chatInput.toast.enhanceDraftChanged': 'הטיוטה השתנתה, לכן הגרסה המשופרת לא הוחלה',
    'chat.chatInput.toast.enhanceReferencesChanged': 'הגרסה המשופרת שינתה את ההפניות שלך, לכן נשמרה הטיוטה המקורית',
    'chat.chatInput.enhancePrompt.disabledNoText': 'הקלד פרומפט קודם',
    'settings.magicPrompts.page.group.promptEnhance.title': 'שיפור פרומפט',
    'settings.magicPrompts.page.group.promptEnhance.description': 'הפרומפט המשמש לשכתוב טיוטת הרכיב לפני השליחה.',
    'settings.magicPrompts.sidebar.item.promptEnhance': 'שיפור פרומפט',
  },
} as const;
```

- [ ] **Step 4: Merge the dictionary into every locale**

In each file below, add the import next to the existing `snippetsI18n` import and the spread next to the existing `...snippetsI18n.<locale>` spread.

| File | Import | Spread |
| --- | --- | --- |
| `en.ts` | `import { promptEnhancementI18n } from './prompt-enhancement.i18n';` | `...promptEnhancementI18n.en,` |
| `de.ts` | same import | `...promptEnhancementI18n.de,` |
| `fr.ts` | same import | `...promptEnhancementI18n.fr,` |
| `nl.ts` | same import | `...promptEnhancementI18n.nl,` |
| `es.ts` | same import | `...promptEnhancementI18n.es,` |
| `ja.ts` | same import | `...promptEnhancementI18n.ja,` |
| `pt-BR.ts` | same import | `...promptEnhancementI18n['pt-BR'],` |
| `uk.ts` | same import | `...promptEnhancementI18n.uk,` |
| `ko.ts` | same import | `...promptEnhancementI18n.ko,` |
| `pl.ts` | same import | `...promptEnhancementI18n.pl,` |
| `zh-CN.ts` | same import | `...promptEnhancementI18n['zh-CN'],` |
| `zh-TW.ts` | same import | `...promptEnhancementI18n['zh-TW'],` |
| `tr.ts` | same import | `...promptEnhancementI18n.tr,` |
| `ar.ts` | same import | `...promptEnhancementI18n.ar,` |
| `he.ts` | same import | `...promptEnhancementI18n.he,` |

- [ ] **Step 5: Run the tests**

Run: `bun test packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.test.ts`

Expected: PASS.

Run: `bun test packages/ui/src/lib/i18n/messages.test.ts`

Expected: PASS, including `all locales stay in key parity with english`.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.ts packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.test.ts packages/ui/src/lib/i18n/messages/*.ts
git commit -m "功能(i18n)：补充提示词增强文案"
```

---

### Task 2: Magic Prompts defaults

**Files:**
- Modify: `packages/ui/src/lib/magicPrompts.ts`
- Test: `packages/ui/src/lib/magicPrompts.test.ts`

**Interfaces:**
- Consumes: `MagicPromptId`, `MagicPromptDefinition`, `MAGIC_PROMPT_DEFINITIONS`.
- Produces: `MagicPromptId` includes `session.promptEnhance.visible` and `session.promptEnhance.instructions`; `getDefaultMagicPromptTemplate('session.promptEnhance.instructions')` returns text containing `{{draft}}`.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/src/lib/magicPrompts.test.ts`:

```ts
describe('prompt enhancement defaults', () => {
  test('the visible role and the instructions are separate prompts', () => {
    expect(getDefaultMagicPromptTemplate('session.promptEnhance.visible')).toContain('rewrite');
    expect(getDefaultMagicPromptTemplate('session.promptEnhance.instructions')).toContain('{{draft}}');
    expect(getDefaultMagicPromptTemplate('session.promptEnhance.instructions')).toContain('Do not answer the request');
  });

  test('an override replaces the enhancement instructions', async () => {
    respond = () => json({ version: 1, overrides: { 'session.promptEnhance.instructions': 'Rewrite: {{draft}}' } });

    const prompts = await loadMagicPrompts('/repo');

    expect(prompts.render('session.promptEnhance.instructions', { draft: 'fix it' })).toBe('Rewrite: fix it');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/lib/magicPrompts.test.ts`

Expected: FAIL because `session.promptEnhance.*` is not a `MagicPromptId`.

- [ ] **Step 3: Add the ids and definitions**

In `packages/ui/src/lib/magicPrompts.ts`, add to the `MagicPromptId` union after `'session.fusion.codeInstructions'`:

```ts
  | 'session.promptEnhance.visible'
  | 'session.promptEnhance.instructions'
```

Add these definitions in `MAGIC_PROMPT_DEFINITIONS` after the `session.fusion` entry:

```ts
  {
    id: 'session.promptEnhance.visible',
    title: 'Prompt Enhancement Role',
    group: 'Session',
    description: 'System message for rewriting a composer draft.',
    template: 'You rewrite a developer\'s draft prompt so a coding agent can act on it without guessing.',
  },
  {
    id: 'session.promptEnhance.instructions',
    title: 'Prompt Enhancement Instructions',
    group: 'Session',
    description: 'Rules and the draft placeholder for rewriting a composer draft.',
    placeholders: [
      { key: 'draft', description: 'The current composer draft.' },
    ],
    template: `Rewrite the draft below. Return only the rewritten prompt: no preamble,
explanations, quotes, or code fences.

Rules:
- Keep the draft's language.
- Keep every file, agent, skill, and snippet reference exactly as written:
  @name, $name, #name, /command, file paths, URLs, inline code, and code blocks.
- Do not answer the request, and do not add facts, files, APIs, or requirements
  the draft does not state.
- Make the goal explicit and organize the request when that helps: task,
  concrete requirements, constraints already implied, and what done looks like.
- Use structure only when the draft has multiple parts. A short draft stays one
  paragraph.
- Resolve an ambiguity only when one reading is clearly intended; otherwise keep
  it open.
- Stay close to the original length. If the draft is already clear, return it
  almost unchanged.

Draft:
{{draft}}`,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ui/src/lib/magicPrompts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/magicPrompts.ts packages/ui/src/lib/magicPrompts.test.ts
git commit -m "功能(魔法提示词)：新增提示词增强默认模板"
```

---

### Task 3: OpenCode generateText signal

**Files:**
- Modify: `packages/ui/src/lib/opencode/client.ts:1979-1985`
- Test: `packages/ui/src/lib/opencode/client.runtime.test.ts`

**Interfaces:**
- Consumes: OpenCode SDK `experimental.generate.text(input, requestOptions)`.
- Produces: `opencodeClient.generateText(prompt, { model?, directory?, signal? }): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/src/lib/opencode/client.runtime.test.ts`:

```ts
test('generateText forwards the caller signal to the OpenCode request', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/auth/url-token') return new Response(null, { status: 404 });
    seen = input instanceof Request ? input.signal : init?.signal ?? undefined;
    return Response.json({ text: 'ok' });
  });
  try {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://generate.test', runtimeKey: 'generate-test' });
    opencodeClient.reconnectToRuntimeBaseUrl();

    await expect(opencodeClient.generateText('hello', {
      model: { providerID: 'provider', id: 'model' },
      signal: controller.signal,
    })).resolves.toBe('ok');

    expect(seen).toBe(controller.signal);
  } finally {
    transport.mockRestore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/lib/opencode/client.runtime.test.ts`

Expected: FAIL because `generateText` does not accept `signal`.

- [ ] **Step 3: Add the signal option**

Replace the `generateText` method in `packages/ui/src/lib/opencode/client.ts`:

```ts
  /** One stateless generation with the server's default model unless `model` is given. */
  async generateText(
    prompt: string,
    options?: { model?: ModelSelection; directory?: string | null; signal?: AbortSignal },
  ): Promise<string> {
    const result = await call("generate.text", () =>
      this.clientFor(options?.directory).experimental.generate.text(
        { prompt, model: options?.model ? toModelRef(options.model) : undefined },
        options?.signal ? { signal: options.signal } : undefined,
      ),
    )
    return result.text
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ui/src/lib/opencode/client.runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/opencode/client.ts packages/ui/src/lib/opencode/client.runtime.test.ts
git commit -m "功能(opencode)：generateText 支持中断信号"
```

---

### Task 4a: Enhancement output guards

**Files:**
- Create: `packages/ui/src/lib/promptEnhancement.ts`
- Test: `packages/ui/src/lib/promptEnhancement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PromptEnhancementErrorCode`
  - `PromptEnhancementError` with `code`
  - `normalizePromptEnhancement(raw): string`
  - `extractProtectedFragments(draft, attachmentFilenames): string[]`
  - `validatePromptEnhancementOutput(draft, attachmentFilenames, raw): { text: string; changed: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/lib/promptEnhancement.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import {
  extractProtectedFragments,
  normalizePromptEnhancement,
  PromptEnhancementError,
  validatePromptEnhancementOutput,
} from './promptEnhancement';

describe('normalizePromptEnhancement', () => {
  test('trims the reply and removes one outer fence', () => {
    expect(normalizePromptEnhancement('  ```text\nRewrite this\n```  ')).toBe('Rewrite this');
    expect(normalizePromptEnhancement('Rewrite this')).toBe('Rewrite this');
  });
});

describe('extractProtectedFragments', () => {
  test('keeps file, skill, snippet, URL and attachment references', () => {
    const fragments = extractProtectedFragments(
      '@src/foo.ts $debug #signoff see https://example.test/x and [diagram.png]',
      ['diagram.png'],
    );

    expect(fragments).toContain('@src/foo.ts');
    expect(fragments).toContain('$debug');
    expect(fragments).toContain('#signoff');
    expect(fragments).toContain('https://example.test/x');
    expect(fragments).toContain('[diagram.png]');
    expect(fragments).not.toContain('$5');
  });
});

describe('validatePromptEnhancementOutput', () => {
  test('an unchanged draft reports no change', () => {
    expect(validatePromptEnhancementOutput('Fix it', [], 'Fix it')).toEqual({ text: 'Fix it', changed: false });
  });

  test('an empty reply fails', () => {
    expect(() => validatePromptEnhancementOutput('Fix it', [], '   ')).toThrow(PromptEnhancementError);
  });

  test('a rewrite that keeps every reference passes', () => {
    const result = validatePromptEnhancementOutput(
      'Fix @src/foo.ts with $debug, see https://example.test/x\n```ts\nconst a = 1;\n```',
      [],
      'Goal: fix the bug in @src/foo.ts using $debug.\nSee https://example.test/x\n```ts\nconst a = 1;\n```',
    );

    expect(result.changed).toBe(true);
    expect(result.text).toContain('@src/foo.ts');
  });

  test('a dropped file reference keeps the original', () => {
    expect(() => validatePromptEnhancementOutput('Fix @src/foo.ts', [], 'Fix the bug')).toThrow(
      expect.objectContaining({ code: 'references-changed' }),
    );
  });

  test('a dropped skill reference keeps the original', () => {
    expect(() => validatePromptEnhancementOutput('Use $debug please', [], 'Please debug it')).toThrow(
      expect.objectContaining({ code: 'references-changed' }),
    );
  });

  test('a dropped snippet reference keeps the original', () => {
    expect(() => validatePromptEnhancementOutput('Use #signoff please', [], 'Please sign off')).toThrow(
      expect.objectContaining({ code: 'references-changed' }),
    );
  });

  test('a dropped URL keeps the original', () => {
    expect(() => validatePromptEnhancementOutput('Read https://example.test/x', [], 'Read the page')).toThrow(
      expect.objectContaining({ code: 'references-changed' }),
    );
  });

  test('a dropped attachment citation keeps the original', () => {
    expect(() => validatePromptEnhancementOutput('Describe [diagram.png]', ['diagram.png'], 'Describe the diagram')).toThrow(
      expect.objectContaining({ code: 'references-changed' }),
    );
  });

  test('a dropped code fence keeps the original', () => {
    expect(() => validatePromptEnhancementOutput('Fix\n```ts\nconst a = 1;\n```', [], 'Fix the code')).toThrow(
      expect.objectContaining({ code: 'references-changed' }),
    );
  });

  test('a runaway rewrite keeps the original', () => {
    const draft = 'Fix the bug';
    const reply = 'Fix the bug '.repeat(200);
    expect(() => validatePromptEnhancementOutput(draft, [], reply)).toThrow(
      expect.objectContaining({ code: 'too-long' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/ui/src/lib/promptEnhancement.test.ts`

Expected: FAIL because `./promptEnhancement` does not exist.

- [ ] **Step 3: Write the guards**

Create `packages/ui/src/lib/promptEnhancement.ts`:

```ts
/**
 * Prompt enhancement: rewrite a composer draft into a clearer prompt.
 *
 * This half owns output normalization and the reference guard. The transport
 * half is added in Task 4b.
 */

export type PromptEnhancementErrorCode =
  | 'empty-output'
  | 'too-long'
  | 'references-changed'
  | 'model-unavailable'
  | 'timeout'
  | 'aborted';

export class PromptEnhancementError extends Error {
  readonly code: PromptEnhancementErrorCode;

  constructor(code: PromptEnhancementErrorCode, message: string) {
    super(message);
    this.name = 'PromptEnhancementError';
    this.code = code;
  }
}

const countFences = (text: string): number => (text.match(/```/g) ?? []).length;

/** Trims the reply and removes one outer Markdown fence when the model wrapped the whole answer. */
export const normalizePromptEnhancement = (raw: string): string => {
  let text = raw.trim();
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  return text;
};

/** Tokens the rewrite must carry through unchanged. */
export const extractProtectedFragments = (
  draft: string,
  attachmentFilenames: readonly string[],
): string[] => {
  const fragments = new Set<string>();
  for (const match of draft.matchAll(/(?:^|\s)(@[^\s]+|\$[A-Za-z_][\w-]*|#[^\s]+)/g)) {
    if (match[1]) fragments.add(match[1]);
  }
  for (const match of draft.matchAll(/https?:\/\/[^\s)]+/g)) {
    fragments.add(match[0]);
  }
  for (const filename of attachmentFilenames) {
    fragments.add(`[${filename}]`);
  }
  return [...fragments];
};

export const validatePromptEnhancementOutput = (
  draft: string,
  attachmentFilenames: readonly string[],
  raw: string,
): { text: string; changed: boolean } => {
  const text = normalizePromptEnhancement(raw);
  if (!text) {
    throw new PromptEnhancementError('empty-output', 'The model returned no text');
  }
  const original = draft.trim();
  if (text === original) {
    return { text: draft, changed: false };
  }
  if (text.length > original.length * 3 && text.length > 1500) {
    throw new PromptEnhancementError('too-long', 'The enhanced prompt grew too far');
  }
  if (countFences(text) < countFences(draft)) {
    throw new PromptEnhancementError('references-changed', 'A code block was removed');
  }
  const missing = extractProtectedFragments(draft, attachmentFilenames)
    .filter((fragment) => !text.includes(fragment));
  if (missing.length > 0) {
    throw new PromptEnhancementError('references-changed', `Missing references: ${missing.join(', ')}`);
  }
  return { text, changed: true };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/ui/src/lib/promptEnhancement.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/promptEnhancement.ts packages/ui/src/lib/promptEnhancement.test.ts
git commit -m "功能(输入框)：校验提示词增强结果"
```

---

### Task 4b: Enhancement transport routing

**Files:**
- Modify: `packages/ui/src/lib/promptEnhancement.ts`
- Test: `packages/ui/src/lib/promptEnhancement.test.ts`

**Interfaces:**
- Consumes:
  - `isVSCodeRuntime()` from `@/lib/desktop`
  - `MagicPromptSnapshot` from `@/lib/magicPrompts`
  - `opencodeClient.generateText`
  - `runtimeFetch`
  - `requestSmallModel`
- Produces:
  - `PromptEnhancementTransport = 'small-model' | 'opencode'`
  - `PromptEnhancementRequest`
  - `PromptEnhancementResult`
  - `renderPromptEnhancementPrompts(prompts, draft): { system: string; prompt: string }`
  - `enhancePromptDraft(request): Promise<PromptEnhancementResult>`

- [ ] **Step 1: Write the failing routing tests**

Append to `packages/ui/src/lib/promptEnhancement.test.ts`. The imports and mocks must run before the module import, so add a separate `describe` block with a dynamic import at the top of the file is not possible after static imports. Replace the file's static import with the block below.

At the top of `packages/ui/src/lib/promptEnhancement.test.ts`, replace:

```ts
import {
  extractProtectedFragments,
  normalizePromptEnhancement,
  PromptEnhancementError,
  validatePromptEnhancementOutput,
} from './promptEnhancement';
```

with:

```ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const generateText = mock(async () => 'OPENCODE TEXT');
let vscodeRuntime = false;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: { generateText },
}));
mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => vscodeRuntime,
}));

const runtimeFetch = mock(async (input: string | URL | Request, _init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  if (url.pathname === '/api/small-model') {
    return Response.json({ available: true, model: { providerID: 'provider', modelID: 'model' } });
  }
  return Response.json({ text: 'SMALL TEXT' });
});
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));

type SmallModelInit = RequestInit & { directory?: string | null };
const requestSmallModel = mock(async (_init: SmallModelInit, _options?: unknown) =>
  Response.json({ text: 'SMALL TEXT' }));
mock.module('@/lib/smallModelRequest', () => ({ requestSmallModel }));

const {
  enhancePromptDraft,
  extractProtectedFragments,
  normalizePromptEnhancement,
  PromptEnhancementError,
  validatePromptEnhancementOutput,
} = await import('./promptEnhancement');
```

Append:

```ts
const prompts = {
  render: (id: string, variables?: Record<string, string>) => (
    id === 'session.promptEnhance.visible' ? 'SYSTEM' : `RULES\n${variables?.draft ?? ''}`
  ),
};

const request = (overrides: Partial<Parameters<typeof enhancePromptDraft>[0]> = {}) => ({
  draft: 'fix the bug',
  prompts,
  directory: '/spaces/space-1/repo',
  providerID: 'provider',
  modelID: 'model',
  attachmentFilenames: [],
  signal: new AbortController().signal,
  timeoutMs: 1000,
  ...overrides,
});

beforeEach(() => {
  generateText.mockClear();
  generateText.mockImplementation(async () => 'OPENCODE TEXT');
  runtimeFetch.mockClear();
  runtimeFetch.mockImplementation(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/small-model') {
      return Response.json({ available: true, model: { providerID: 'provider', modelID: 'model' } });
    }
    return Response.json({ text: 'SMALL TEXT' });
  });
  requestSmallModel.mockClear();
  requestSmallModel.mockImplementation(async () => Response.json({ text: 'SMALL TEXT' }));
  vscodeRuntime = false;
});

describe('enhancePromptDraft', () => {
  test('uses the Small Model when the resolved provider matches and carries the space directory', async () => {
    const result = await enhancePromptDraft(request());

    expect(result).toEqual({ text: 'SMALL TEXT', changed: true, transport: 'small-model' });
    expect(generateText).not.toHaveBeenCalled();
    expect(requestSmallModel).toHaveBeenCalledTimes(1);
    const [init] = requestSmallModel.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      system: 'SYSTEM',
      directory: '/spaces/space-1/repo',
      preferredProviderID: 'provider',
      preferredModelID: 'model',
      restrictToPreferredProvider: true,
    });
    expect(body.prompt).toContain('fix the bug');
    expect(init?.directory).toBe('/spaces/space-1/repo');
  });

  test('uses OpenCode with the current model when the Small Model resolves to another provider', async () => {
    runtimeFetch.mockResolvedValueOnce(Response.json({ available: true, model: { providerID: 'other' } }));

    const result = await enhancePromptDraft(request());

    expect(result.transport).toBe('opencode');
    expect(requestSmallModel).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledWith('SYSTEM\n\nRULES\nfix the bug', {
      model: { providerID: 'provider', id: 'model' },
      directory: '/spaces/space-1/repo',
      signal: expect.any(AbortSignal),
    });
  });

  test('uses OpenCode when the Small Model is unavailable or the pre-flight fails', async () => {
    runtimeFetch.mockResolvedValueOnce(Response.json({ available: false, model: null }));
    expect((await enhancePromptDraft(request())).transport).toBe('opencode');

    runtimeFetch.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    expect((await enhancePromptDraft(request())).transport).toBe('opencode');
  });

  test('the VS Code runtime uses OpenCode and never reads the Small Model', async () => {
    vscodeRuntime = true;

    const result = await enhancePromptDraft(request());

    expect(result.transport).toBe('opencode');
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(requestSmallModel).not.toHaveBeenCalled();
  });

  test('a small-model 404 falls back to OpenCode', async () => {
    requestSmallModel.mockResolvedValueOnce(Response.json(
      { error: 'No small model', code: 'small-model-unavailable' },
      { status: 404 },
    ));

    const result = await enhancePromptDraft(request());

    expect(result.transport).toBe('opencode');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test('a hung request aborts at the timeout', async () => {
    runtimeFetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));

    await expect(enhancePromptDraft(request({ timeoutMs: 10 }))).rejects.toMatchObject({ code: 'timeout' });
    expect(generateText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/ui/src/lib/promptEnhancement.test.ts`

Expected: FAIL because `enhancePromptDraft` is not exported.

- [ ] **Step 3: Add the transport**

At the top of `packages/ui/src/lib/promptEnhancement.ts`, add:

```ts
import { isVSCodeRuntime } from '@/lib/desktop';
import type { MagicPromptSnapshot } from '@/lib/magicPrompts';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { requestSmallModel } from '@/lib/smallModelRequest';
```

Append:

```ts
export type PromptEnhancementTransport = 'small-model' | 'opencode';

export type PromptEnhancementResult = {
  text: string;
  changed: boolean;
  transport: PromptEnhancementTransport;
};

export type PromptEnhancementRequest = {
  draft: string;
  prompts: MagicPromptSnapshot;
  directory: string | null;
  providerID: string;
  modelID: string;
  attachmentFilenames: readonly string[];
  signal: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

export const renderPromptEnhancementPrompts = (prompts: MagicPromptSnapshot, draft: string) => ({
  system: prompts.render('session.promptEnhance.visible'),
  prompt: prompts.render('session.promptEnhance.instructions', { draft }),
});

type SmallModelResolution = {
  available: boolean;
  model?: { providerID?: string; modelID?: string } | null;
};

const readSmallModelResolution = async (
  request: PromptEnhancementRequest,
  signal: AbortSignal,
): Promise<SmallModelResolution | null> => {
  try {
    const query = new URLSearchParams({ providerID: request.providerID, modelID: request.modelID });
    if (request.directory) query.set('directory', request.directory);
    const response = await runtimeFetch(`/api/small-model?${query.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      directory: request.directory,
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as SmallModelResolution | null;
    return payload && typeof payload.available === 'boolean' ? payload : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
};

const requestSmallModelText = async (
  request: PromptEnhancementRequest,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> => {
  const response = await requestSmallModel({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      prompt,
      directory: request.directory ?? undefined,
      preferredProviderID: request.providerID,
      preferredModelID: request.modelID,
      maxOutputTokens: 1024,
      restrictToPreferredProvider: true,
    }),
    directory: request.directory,
    signal,
  }, { notifyOnError: false });

  const payload = await response.json().catch(() => null) as {
    text?: unknown;
    error?: unknown;
    code?: unknown;
  } | null;
  if (!response.ok) {
    const detail = typeof payload?.error === 'string' ? `: ${payload.error}` : '';
    throw new PromptEnhancementError('model-unavailable', `The Small Model is unavailable${detail}`);
  }
  if (typeof payload?.text !== 'string') {
    throw new PromptEnhancementError('empty-output', 'The Small Model returned no text');
  }
  return payload.text;
};

const generateInOpenCode = async (
  request: PromptEnhancementRequest,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> => opencodeClient.generateText(`${system}\n\n${prompt}`, {
  model: { providerID: request.providerID, id: request.modelID },
  directory: request.directory,
  signal,
});

export async function enhancePromptDraft(
  request: PromptEnhancementRequest,
): Promise<PromptEnhancementResult> {
  const { system, prompt } = renderPromptEnhancementPrompts(request.prompts, request.draft);
  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new PromptEnhancementError('timeout', 'Prompt enhancement timed out')),
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const finish = (raw: string, transport: PromptEnhancementTransport): PromptEnhancementResult => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const validated = validatePromptEnhancementOutput(request.draft, request.attachmentFilenames, raw);
    return { ...validated, transport };
  };

  try {
    if (isVSCodeRuntime()) {
      return finish(await generateInOpenCode(request, system, prompt, controller.signal), 'opencode');
    }

    const resolution = await readSmallModelResolution(request, controller.signal);
    const smallModelIsSafe = resolution?.available === true
      && resolution.model?.providerID === request.providerID;
    if (smallModelIsSafe) {
      try {
        return finish(await requestSmallModelText(request, system, prompt, controller.signal), 'small-model');
      } catch (error) {
        const unusable = error instanceof PromptEnhancementError
          && (error.code === 'model-unavailable'
            || error.code === 'empty-output'
            || error.code === 'too-long'
            || error.code === 'references-changed');
        if (!unusable) throw error;
      }
    }

    return finish(await generateInOpenCode(request, system, prompt, controller.signal), 'opencode');
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof PromptEnhancementError) throw reason;
      throw new PromptEnhancementError('aborted', 'Prompt enhancement was cancelled');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', onAbort);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/ui/src/lib/promptEnhancement.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/promptEnhancement.ts packages/ui/src/lib/promptEnhancement.test.ts
git commit -m "功能(输入框)：小模型路由与回退"
```

---

### Task 5: Composer enhance button

**Files:**
- Create: `packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.tsx`
- Create: `packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.test.tsx`
- Modify: `packages/ui/src/components/icon/sprite.ts` (generated)

**Interfaces:**
- Consumes: `Icon`, `Tooltip`, `useI18n`.
- Produces: `ComposerEnhanceButton` with `state: 'disabled' | 'ready' | 'loading'`, optional `disabledReason`, `footerIconButtonClass`, `iconSizeClass`, `onClick`.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.test.tsx`:

```tsx
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ComposerEnhanceButton } from './ComposerEnhanceButton';

const renderButton = async (state: 'disabled' | 'ready' | 'loading', disabledReason?: string) => {
  const win = new Window({ url: 'http://localhost' });
  const values = {
    window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement,
    Event: win.Event, MouseEvent: win.MouseEvent, MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const root = createRoot(container);
  let clicks = 0;
  try {
    await act(async () => root.render(
      <ThemeSystemProvider>
        <I18nProvider>
          <TooltipProvider>
            <ComposerEnhanceButton
              state={state}
              disabledReason={disabledReason}
              footerIconButtonClass="h-6 w-6"
              iconSizeClass="h-4 w-4"
              onClick={() => { clicks += 1; }}
            />
          </TooltipProvider>
        </I18nProvider>
      </ThemeSystemProvider>,
    ));
    const button = container.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('The button did not mount');
    const result = {
      button,
      clicks: () => clicks,
      markup: button.outerHTML,
    };
    await act(async () => button.click());
    return result;
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
};

describe('ComposerEnhanceButton', () => {
  test('ready shows the magic icon and calls onClick', async () => {
    const { button, clicks, markup } = await renderButton('ready');

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Enhance prompt');
    expect(markup).toContain('#oc-magic');
    expect(clicks()).toBe(1);
  });

  test('loading disables the button and spins the loader', async () => {
    const { button, clicks, markup } = await renderButton('loading');

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(markup).toContain('#oc-loader-4');
    expect(markup).toContain('animate-spin');
    expect(clicks()).toBe(0);
  });

  test('disabled does not call onClick', async () => {
    const { button, clicks } = await renderButton('disabled', 'Type a prompt first');

    expect(button.disabled).toBe(true);
    expect(clicks()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.test.tsx`

Expected: FAIL because `./ComposerEnhanceButton` does not exist.

- [ ] **Step 3: Write the component**

Create `packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.tsx`:

```tsx
/**
 * The composer's prompt enhancement control.
 *
 * It rewrites the draft in place and never sends it. The button lives beside
 * the send disc on desktop and inside the VS Code footer; mobile does not
 * render it.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ComposerEnhanceButtonProps = {
    state: 'disabled' | 'ready' | 'loading';
    disabledReason?: string;
    footerIconButtonClass: string;
    iconSizeClass: string;
    onClick: () => void;
};

export const ComposerEnhanceButton = React.memo(function ComposerEnhanceButton(props: ComposerEnhanceButtonProps) {
    const { t } = useI18n();
    const label = t('chat.chatInput.actions.enhancePrompt');
    const loading = props.state === 'loading';
    const disabled = props.state === 'disabled' || loading;
    const tooltip = props.state === 'disabled' && props.disabledReason ? props.disabledReason : label;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                {/* The span keeps the tooltip reachable while the button is disabled. */}
                <span className="inline-flex">
                    <button
                        type="button"
                        onClick={props.onClick}
                        disabled={disabled}
                        aria-label={label}
                        aria-busy={loading || undefined}
                        className={props.footerIconButtonClass}
                        onMouseDown={(event) => event.preventDefault()}
                    >
                        <Icon
                            name={loading ? 'loader-4' : 'magic'}
                            className={cn(props.iconSizeClass, 'text-current', loading && 'animate-spin')}
                        />
                    </button>
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>{tooltip}</TooltipContent>
        </Tooltip>
    );
});
```

- [ ] **Step 4: Regenerate the icon sprite**

Run: `bun run icons:generate`

Expected: `packages/ui/src/components/icon/sprite.ts` includes `magic`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.tsx packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.test.tsx packages/ui/src/components/icon/sprite.ts
git commit -m "功能(输入框)：新增增强提示词按钮"
```

---

### Task 6: Footer and ChatInput integration

**Files:**
- Modify: `packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx`
- Modify: `packages/ui/src/components/chat/ChatInput.tsx`
- Test: `packages/ui/src/components/chat/__tests__/ChatInput.enhance.test.tsx`

**Interfaces:**
- Consumes: `ComposerEnhanceButton`, `enhancePromptDraft`, `PromptEnhancementError`, `loadMagicPrompts`, `parseSlashCommand`.
- Produces: `ComposerFooter` accepts `enhancePrompt: { state: 'hidden' | 'disabled' | 'ready' | 'loading'; disabledReason?: string; onClick: () => void }`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/ui/src/components/chat/__tests__/ChatInput.enhance.test.tsx`:

```tsx
import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  Window,
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Text: browser.Text,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range,
  Selection: browser.Selection,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent,
  InputEvent: browser.InputEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const WORKTREE = '/elsewhere/feature';
const PROJECTS = [WORKTREE, '/repo'].map((path) => ({ id: createProjectIdFromPath(path), path }));

let enhanceResponse: Response | Promise<Response> | null = null;

const responseFor = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  const directory = decodeURIComponent(headers.get('x-opencode-directory') ?? url.searchParams.get('location[directory]') ?? WORKTREE);
  const location = { directory, project: { id: 'project', directory, canonical: directory } };
  if (url.pathname === '/api/config/settings') return Response.json({ projects: PROJECTS });
  if (url.pathname.endsWith('/fs/home')) return Response.json({ home: '/home/test' });
  if (url.pathname.endsWith('/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
  if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  if (url.pathname === '/api/config' || url.pathname === '/api/project') return Response.json([]);
  if (url.pathname.endsWith('/session/active')) return Response.json({ data: {} });
  if (url.pathname.endsWith('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
  if (url.pathname === '/api/magic-prompts') return Response.json({ version: 1, overrides: {} });
  if (url.pathname === '/api/small-model') {
    return Response.json({ available: true, model: { providerID: 'provider', modelID: 'model' } });
  }
  if (url.pathname === '/api/small-model/generate') {
    return enhanceResponse ?? Response.json({ text: 'Enhanced text' });
  }
  if (url.pathname.endsWith('/location')) return Response.json(location);
  const sessionId = url.pathname.match(/\/session\/(ses_feature)$/)?.[1];
  if (sessionId) return Response.json({ data: {
    id: sessionId, projectID: 'project', location: { directory: WORKTREE }, title: sessionId,
    time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    metadata: {},
  } });
  if (url.pathname.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({ location, data: [], cursor: {} });
};
spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => responseFor(input, init));

plugin({
  name: 'composer-enhance-vite-modules',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { undo } = await import('@codemirror/commands');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore, ensureHomeDirectoryResolved } = await import('@/stores/useDirectoryStore');
const { updateDesktopSettings } = await import('@/lib/persistence');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { OpenCode } = await import('@opencode/client');
const { opencodeClient } = await import('@/lib/opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request, init) => responseFor(request, init),
});

const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

let sent: string[] = [];

beforeEach(() => {
  useProjectsStore.setState({ projects: PROJECTS });
  sent = [];
  enhanceResponse = null;
  useDirectoryStore.setState({ currentDirectory: WORKTREE });
  useSessionUIStore.setState({
    currentSessionId: 'ses_feature',
    currentSessionDirectory: WORKTREE,
    sendMessage: async (content) => { sent.push(content); },
  });
  useConfigStore.setState({
    currentProviderId: 'provider',
    currentModelId: 'model',
    isConnected: true,
    hasEverConnected: true,
  });
});

afterAll(() => {
  browser.close();
});

const mountComposer = async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <SyncProvider sdk={sdk} directory={WORKTREE}>
              <ChatInput />
            </SyncProvider>
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    );
  });
  await act(async () => {
    await ensureHomeDirectoryResolved();
    await updateDesktopSettings({});
  });
  await act(async () => {
    // Project activation can apply defaults after mount; catalog discovery is
    // outside this test, so pin the fixture's model before enhancing.
    useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model' });
  });
  const content = container.querySelector<HTMLElement>('.cm-content');
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) throw new Error('The composer did not mount');
  return { container, root, view };
};

const typeDraft = async (view: InstanceType<typeof EditorView>, text: string) => {
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
  });
};

const clickEnhance = async (container: HTMLElement, waitMs = 300) => {
  await act(async () => {
    // Project activation can apply defaults after typing; pin the fixture's model.
    useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model' });
    await new Promise((done) => setTimeout(done, 300));
  });
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Enhance prompt"]');
  if (!button) throw new Error('The enhance button did not mount');
  await act(async () => {
    button.click();
    await new Promise((done) => setTimeout(done, waitMs));
  });
};

test('enhances the draft in place and never sends it', async () => {
  const { container, root, view } = await mountComposer();
  try {
    await typeDraft(view, 'make this better');
    await clickEnhance(container);

    expect(view.state.doc.toString()).toBe('Enhanced text');
    expect(sent).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('undo restores the draft', async () => {
  const { container, root, view } = await mountComposer();
  try {
    await typeDraft(view, 'make this better');
    await clickEnhance(container);
    expect(view.state.doc.toString()).toBe('Enhanced text');

    await act(async () => { undo(view); });

    expect(view.state.doc.toString()).toBe('make this better');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('a draft changed during the request is not overwritten', async () => {
  const { container, root, view } = await mountComposer();
  let release = () => {};
  enhanceResponse = new Promise<Response>((resolve) => {
    release = () => resolve(Response.json({ text: 'Enhanced text' }));
  });
  try {
    await typeDraft(view, 'make this better');
    await clickEnhance(container, 50);
    await typeDraft(view, 'make this better now');
    await act(async () => {
      release();
      await new Promise((done) => setTimeout(done, 300));
    });

    expect(view.state.doc.toString()).toBe('make this better now');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('a rewrite that drops a reference keeps the original', async () => {
  const { container, root, view } = await mountComposer();
  enhanceResponse = Response.json({ text: 'Please fix the bug.' });
  // The Small Model reply drops the mention; the OpenCode fallback does too.
  const generate = spyOn(opencodeClient, 'generateText').mockResolvedValue('OPENCODE TEXT');
  try {
    await typeDraft(view, '@src/foo.ts please fix');
    await clickEnhance(container);

    expect(view.state.doc.toString()).toBe('@src/foo.ts please fix');
  } finally {
    generate.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/components/chat/__tests__/ChatInput.enhance.test.tsx`

Expected: FAIL because the enhance button does not exist.

- [ ] **Step 3: Add the footer control**

In `packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx`, import the button:

```ts
import { ComposerEnhanceButton } from './ComposerEnhanceButton';
```

Add to `ComposerFooterProps`:

```ts
    enhancePrompt: {
        state: 'hidden' | 'disabled' | 'ready' | 'loading';
        disabledReason?: string;
        onClick: () => void;
    };
```

Destructure it in `ComposerFooterView`:

```ts
        enhancePrompt,
```

In the desktop right cluster, insert before `MemoComposerDictation`:

```tsx
                        {enhancePrompt.state !== 'hidden' ? (
                            <ComposerEnhanceButton
                                state={enhancePrompt.state}
                                disabledReason={enhancePrompt.disabledReason}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                onClick={enhancePrompt.onClick}
                            />
                        ) : null}
```

The mobile branch is untouched.

- [ ] **Step 4: Add the ChatInput state and handler**

In `packages/ui/src/components/chat/ChatInput.tsx`, add `parseSlashCommand` to the import from `./composer/submit/slashCommands` (line 257):

```ts
    parseSlashCommand,
```

Add the enhancement module import:

```ts
import { enhancePromptDraft, PromptEnhancementError } from '@/lib/promptEnhancement';
```

Near `composerRef`:

```ts
    const [isEnhancingPrompt, setIsEnhancingPrompt] = React.useState(false);
    const enhanceAbortRef = React.useRef<AbortController | null>(null);
```

Near `waitingForOpenCode`, add:

```ts
    const canEnhancePrompt = !isMobile
        && !isBtwActive
        && !parallelRun
        && inputMode === 'normal'
        && !waitingForOpenCode
        && !parseSlashCommand(message)
        && /\p{L}/u.test(message)
        && Boolean(currentProviderId && currentModelId);

    const showEnhancePrompt = !isMobile
        && !isBtwActive
        && !parallelRun
        && inputMode === 'normal'
        && !parseSlashCommand(message);

    const enhancePromptDisabledReason = !/\p{L}/u.test(message)
        ? t('chat.chatInput.enhancePrompt.disabledNoText')
        : !currentProviderId || !currentModelId
            ? t('chat.chatInput.toast.noModelSelected')
            : waitingForOpenCode
                ? t('chat.chatInput.waitingForOpenCode')
                : undefined;

    const handleEnhancePrompt = React.useCallback(async () => {
        if (isEnhancingPrompt || !canEnhancePrompt) return;
        const snapshot = messageRef.current;
        const identity = chatDraftIdentity;
        const directory = currentSessionDirectoryForSync ?? currentDirectory ?? null;
        const providerID = currentProviderId;
        const modelID = currentModelId;
        if (!providerID || !modelID) {
            toast.error(t('chat.chatInput.toast.noModelSelected'));
            return;
        }

        const controller = new AbortController();
        enhanceAbortRef.current = controller;
        setIsEnhancingPrompt(true);
        try {
            const prompts = await loadMagicPrompts(directory);
            const result = await enhancePromptDraft({
                draft: snapshot,
                prompts,
                directory,
                providerID,
                modelID,
                attachmentFilenames: attachedFiles.map((file) => file.filename),
                signal: controller.signal,
            });
            if (controller.signal.aborted) return;
            if (getChatDraftIdentityKey(currentChatDraftIdentityRef.current) !== getChatDraftIdentityKey(identity)
                || messageRef.current !== snapshot) {
                toast.info(t('chat.chatInput.toast.enhanceDraftChanged'));
                return;
            }
            if (!result.changed) {
                toast.info(t('chat.chatInput.toast.enhanceNoChange'));
                return;
            }
            setMessage(result.text);
            toast.success(t('chat.chatInput.toast.enhanceSuccess'), {
                id: 'prompt-enhance',
                duration: 4000,
                action: {
                    label: t('chat.chatInput.actions.undo'),
                    onClick: () => {
                        if (messageRef.current !== result.text) {
                            toast.info(t('chat.chatInput.toast.enhanceDraftChanged'));
                            return;
                        }
                        setMessage(snapshot);
                        requestAnimationFrame(() => composerRef.current?.focus());
                    },
                },
            });
            requestAnimationFrame(() => composerRef.current?.focus());
        } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof PromptEnhancementError && error.code === 'timeout') {
                toast.error(t('chat.chatInput.toast.enhanceTimeout'));
            } else if (error instanceof PromptEnhancementError && error.code === 'references-changed') {
                toast.error(t('chat.chatInput.toast.enhanceReferencesChanged'));
            } else {
                toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.enhanceFailed')));
            }
        } finally {
            if (enhanceAbortRef.current === controller) {
                enhanceAbortRef.current = null;
                setIsEnhancingPrompt(false);
            }
        }
    }, [
        attachedFiles,
        canEnhancePrompt,
        chatDraftIdentity,
        currentDirectory,
        currentModelId,
        currentProviderId,
        currentSessionDirectoryForSync,
        isEnhancingPrompt,
        t,
    ]);

    const enhancePrompt = React.useMemo(() => ({
        state: !showEnhancePrompt
            ? 'hidden' as const
            : isEnhancingPrompt
                ? 'loading' as const
                : canEnhancePrompt
                    ? 'ready' as const
                    : 'disabled' as const,
        disabledReason: enhancePromptDisabledReason,
        onClick: handleEnhancePrompt,
    }), [canEnhancePrompt, enhancePromptDisabledReason, handleEnhancePrompt, isEnhancingPrompt, showEnhancePrompt]);

    React.useEffect(() => () => {
        enhanceAbortRef.current?.abort();
    }, []);

    React.useEffect(() => {
        enhanceAbortRef.current?.abort();
    }, [chatDraftIdentity]);
```

Pass the prop in the `ComposerFooter` call:

```tsx
                        enhancePrompt={enhancePrompt}
```

- [ ] **Step 5: Run the integration test**

Run: `bun test packages/ui/src/components/chat/__tests__/ChatInput.enhance.test.tsx`

Expected: PASS.

- [ ] **Step 6: Run the existing composer tests**

Run: `bun test packages/ui/src/components/chat/__tests__/ChatInput.magicPrompts.test.tsx`

Expected: PASS.

Run: `bun test packages/ui/src/components/chat/composer/ui/ComposerActionButtons.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/components/chat/ChatInput.tsx packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx packages/ui/src/components/chat/__tests__/ChatInput.enhance.test.tsx
git commit -m "功能(输入框)：接入提示词增强流程"
```

---

### Task 7: Magic Prompts settings entry

**Files:**
- Modify: `packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.tsx`
- Modify: `packages/ui/src/components/sections/magic-prompts/MagicPromptsSidebar.tsx`
- Test: `packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.test.tsx`

**Interfaces:**
- Consumes: `session.promptEnhance.*` from Task 2, the settings i18n keys from Task 1.
- Produces: the `session.promptEnhance` page with visible and instructions blocks, and a sidebar item under Session.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.test.tsx`:

```ts
test('shows the prompt enhancement templates', async () => {
  useProjects([{ id: 'proj', path: '/work/proj' }]);
  useMagicPromptsStore.getState().setSelectedPromptId('session.promptEnhance');

  await mount();

  expect(container.textContent).toContain('Prompt Enhancement');
  expect(field('Visible prompt')?.value).toContain('rewrite');
  expect(field('Instructions')?.value).toContain('{{draft}}');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.test.tsx`

Expected: FAIL because the page has no `session.promptEnhance` entry.

- [ ] **Step 3: Add the page and sidebar entries**

In `MagicPromptsPage.tsx`, add after the `session.fusion` entry:

```ts
  'session.promptEnhance': {
    titleKey: 'settings.magicPrompts.page.group.promptEnhance.title',
    descriptionKey: 'settings.magicPrompts.page.group.promptEnhance.description',
    blocks: [
      { id: 'session.promptEnhance.visible', titleKey: 'settings.magicPrompts.page.block.visiblePrompt' },
      { id: 'session.promptEnhance.instructions', titleKey: 'settings.magicPrompts.page.block.instructions' },
    ],
  },
```

In `MagicPromptsSidebar.tsx`, add under the Session group after `session.fusion`:

```ts
          { id: 'session.promptEnhance', titleKey: 'settings.magicPrompts.sidebar.item.promptEnhance' },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.tsx packages/ui/src/components/sections/magic-prompts/MagicPromptsSidebar.tsx packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.test.tsx
git commit -m "功能(设置)：暴露提示词增强 Magic Prompt"
```

---

### Task 8: Documentation

**Files:**
- Modify: `packages/docs/content/docs/chat-input.mdx`
- Modify: `packages/docs/content/docs/magic-prompts.mdx`

**Interfaces:**
- Consumes: the behavior from Tasks 5 and 6.
- Produces: English docs for the button and the prompt entry.

- [ ] **Step 1: Add the chat input section**

In `packages/docs/content/docs/chat-input.mdx`, add after the `## Commands` section:

```md
## Enhance a draft

The wand button beside the send control rewrites the draft before you send it. It makes the goal explicit and organizes implied requirements, and it keeps file, skill and snippet references, URLs, code blocks and attachment citations intact.

The rewrite replaces the draft in place. It never sends automatically. Press Ctrl+Z, or use Undo in the notice, to restore the previous text.

The button is hidden for shell commands, slash commands, BTW and parallel composers, and on mobile. The web and desktop apps use the Small Model; the VS Code extension uses the session's current model.
```

- [ ] **Step 2: Add the Magic Prompts row**

In `packages/docs/content/docs/magic-prompts.mdx`, add to the Session table after the Fusion row:

```md
| Prompt enhancement | The enhance button beside the composer's send control | You rewrite the current draft before sending. The draft is replaced in place and is never sent automatically. |
```

- [ ] **Step 3: Check the links and headings**

Run: `rg -n "Enhance a draft|Prompt enhancement" packages/docs/content/docs/chat-input.mdx packages/docs/content/docs/magic-prompts.mdx`

Expected: both strings appear once.

- [ ] **Step 4: Commit**

```bash
git add packages/docs/content/docs/chat-input.mdx packages/docs/content/docs/magic-prompts.mdx
git commit -m "文档(输入框)：补充提示词增强说明"
```

---

### Task 9: Verification

**Files:** none.

- [ ] **Step 1: Run the new and affected tests**

Run:

```bash
bun test packages/ui/src/lib/i18n/messages/prompt-enhancement.i18n.test.ts
bun test packages/ui/src/lib/i18n/messages.test.ts
bun test packages/ui/src/lib/magicPrompts.test.ts
bun test packages/ui/src/lib/opencode/client.runtime.test.ts
bun test packages/ui/src/lib/promptEnhancement.test.ts
bun test packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.test.tsx
bun test packages/ui/src/components/chat/__tests__/ChatInput.enhance.test.tsx
bun test packages/ui/src/components/chat/__tests__/ChatInput.magicPrompts.test.tsx
bun test packages/ui/src/components/chat/composer/ui/ComposerActionButtons.test.tsx
bun test packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.test.tsx
```

Expected: all PASS.

- [ ] **Step 2: Run the changed-code check**

Run: `bun run check:changed --base HEAD`

Expected: PASS. Fix new findings; do not silence rules or weaken types.

- [ ] **Step 3: Manual verification**

Run the app and check:

1. Browser desktop: type a Chinese draft, click the wand, review the replacement, press Ctrl+Z, and confirm the message was not sent.
2. Browser desktop: click the toast Undo and confirm the original draft returns.
3. Browser desktop: type, click Enhance, keep typing before the reply, and confirm the new text survives.
4. Browser desktop: put `@` file mention, a `#` snippet and a code block in the draft, enhance, and confirm they survive or the original is kept.
5. Electron: repeat step 1.
6. VS Code extension: repeat step 1 and confirm no request to `/api/small-model/generate` appears in the extension log.
7. Isolated space: enhance a draft and confirm the request carries the space directory.
8. Small Model unavailable: set the Small Model to an unauthenticated provider, enhance, and confirm the current model is used.
9. Timeout: point the Small Model at a model that does not answer and confirm the 20-second timeout leaves the draft unchanged.
10. Mobile: confirm the wand button is absent and the footer is unchanged.
11. Settings: open Magic Prompts, select Prompt Enhancement, edit the instructions, save, and confirm the next enhancement uses the edit.

- [ ] **Step 4: Hand off**

Report the test results, the check:changed result, the manual checks that passed, and any that could not be run. Leave the working tree for review. Do not merge.

---

## Self-Review

**Spec coverage:** The i18n, Magic Prompts, client signal, output guards, transport routing, button, composer wiring, settings entry, docs, and verification tasks cover the spec. The strict provider pre-flight is Task 4b. The space directory is asserted in Task 4b. The stale draft, undo, no-change, and reference guards are Task 6. Mobile stays untouched in Task 6. The disabled tooltip reuses `chat.chatInput.toast.noModelSelected` and `chat.chatInput.waitingForOpenCode` instead of adding near-duplicate keys.

**Placeholder scan:** No TBD or TODO. Every code step carries the actual code. The only conditional is the global commit permission required by the repository rules.

**Type consistency:** `PromptEnhancementRequest`, `PromptEnhancementResult`, `PromptEnhancementError`, `enhancePromptDraft`, `ComposerEnhanceButton` props, and the `enhancePrompt` footer prop use the same shapes across Tasks 4a, 4b, 5, and 6. The i18n keys in Task 1 match the keys used in Tasks 5, 6, and 7.

**Review focus:** Each of the five failure modes has a test in its owning task, as listed at the top.
