import { useEffect, useState } from "react";
import { api } from "./client";

type Note = { id: number; body: string };

export function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  // no client-side auth: the user is already signed in at the gateway
  useEffect(() => {
    api<Note[]>("/api/notes")
      .then(setNotes)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function add() {
    if (!draft.trim()) return;
    setError("");
    try {
      const note = await api<Note>("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: draft }),
      });
      setNotes([...notes, note]);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Mes notes</h1>
      {error && <p style={{ color: "#a33" }}>{error}</p>}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={add}>Ajouter</button>
      <ul>{notes.map((n) => <li key={n.id}>{n.body}</li>)}</ul>
    </main>
  );
}
