export function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <span>{label}</span>
      <div>{value || "Не указан"}</div>
    </div>
  );
}
