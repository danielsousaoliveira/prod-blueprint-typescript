export function SettingsPage() {
  return (
    <section
      aria-labelledby="settings-heading"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h1
        id="settings-heading"
        className="text-lg font-semibold tracking-tight text-slate-900"
      >
        Settings
      </h1>
      <p className="mt-2 text-sm text-slate-500">
        Account settings live here. This starter ships an empty settings area for a
        product built on it to fill in.
      </p>
    </section>
  );
}
