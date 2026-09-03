import { useEffect, useState } from "react";
import { api } from "./client";

type Note = { id: number; body: string; createdAt: string };

// Four states, not one. On a scale-to-zero platform the first visit is almost
// always the slow one, and an empty list on a cold app must not look like a
// bug: loading, waking, empty and error each say something different.
type Status = "loading" | "waking" | "ready" | "error";

export function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // no client-side auth: the user is already signed in at the gateway
  useEffect(() => {
    api<Note[]>("/api/notes", undefined, { onWaking: () => setStatus("waking") })
      .then((rows) => {
        setNotes(rows);
        setStatus("ready");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
  }, []);

  async function add() {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    setError("");
    try {
      const note = await api<Note>("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      setNotes([note, ...notes]);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page stack-loose">
      <header className="spread">
        <h1>Mes notes</h1>
        <span className="label">{notes.length} enregistrées</span>
      </header>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Écrire une note"
          aria-label="Nouvelle note"
          style={{ flex: 1 }}
        />
        <button data-primary type="submit" disabled={!draft.trim() || saving}>
          {saving ? "Enregistrement" : "Ajouter"}
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {status === "loading" && <p className="muted">Chargement</p>}
      {status === "waking" && <p className="waking">Réveil du serveur</p>}
      {status === "ready" && notes.length === 0 && (
        <p className="empty">Aucune note pour l'instant. La première ligne suffit à commencer.</p>
      )}

      {notes.length > 0 && (
        <ul className="ruled stack-tight" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {notes.map((n) => (
            <li key={n.id} className="spread">
              <span>{n.body}</span>
              <time className="num caption" dateTime={n.createdAt}>
                {new Date(n.createdAt).toLocaleDateString("fr-FR", {
                  day: "2-digit",
                  month: "2-digit",
                })}
              </time>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
