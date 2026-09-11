import { animate } from "@/shared/lib/view-transition";
import { Spinner } from "@/shared/ui/spinner";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { tunnelApi, type Profile, type State } from "@/entities/tunnel";
export function ConfigEditor({
  profile,
  close,
  saved,
}: {
  profile: Profile;
  close: () => void;
  saved: (s: State) => void;
}) {
  const [text, setText] = useState(""),
    [original, setOriginal] = useState(""),
    [revision, setRevision] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [discard, setDiscard] = useState(false);
  useEffect(() => {
    let alive = true;
    tunnelApi
      .readConfig(profile.id)
      .then((result) => {
        if (alive) {
          setText(result.text);
          setOriginal(result.text);
          setRevision(result.revision);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [profile.id]);
  const dismiss = () => {
    if (saving) return;
    if (text !== original) animate(() => setDiscard(true));
    else close();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [text, original, saving]);
  async function save() {
    animate(() => {
      setSaving(true);
      setError("");
    });
    try {
      saved(await tunnelApi.saveConfig(profile.id, text, revision));
    } catch (e) {
      animate(() => setError((e as Error).message));
    } finally {
      animate(() => setSaving(false));
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="config-editor"
        role="dialog"
        aria-modal="true"
        aria-label="Редактор конфигурации"
      >
        <div className="editor-heading">
          <div>
            <h2>Конфигурация</h2>
            <p>{profile.name}</p>
          </div>
          <button
            className="icon"
            aria-label="Закрыть редактор"
            onClick={dismiss}
          >
            <X size={18} />
          </button>
        </div>
        <p className="editor-note">
          Ключи скрыты маркерами &lt;UNCHANGED_KEY_…&gt;. Оставьте их для
          сохранения текущих ключей или вставьте новые.
        </p>
        {profile.active && (
          <p className="editor-note">
            Для сохранения сначала отключите этот туннель.
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <textarea
          aria-label="Конфигурация WireGuard"
          autoFocus
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          disabled={!revision || saving}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="editor-actions">
          {discard ? (
            <>
              <span>Отменить несохранённые изменения?</span>
              <button
                className="icon"
                onClick={() => animate(() => setDiscard(false))}
              >
                Продолжить
              </button>
              <button className="icon" onClick={close}>
                Отменить изменения
              </button>
            </>
          ) : (
            <>
              <button className="icon" onClick={dismiss}>
                Отмена
              </button>
              <button
                className="primary"
                disabled={!revision || saving || text === original}
                onClick={save}
              >
                {saving && <Spinner />}
                {saving ? "Сохранение…" : "Сохранить"}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
