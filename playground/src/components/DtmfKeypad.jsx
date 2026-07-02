const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export default function DtmfKeypad({ onPress, disabled }) {
  return (
    <div className="dtmf-keypad">
      {KEYS.map((k) => (
        <button key={k} disabled={disabled} onClick={() => onPress(k)} className="dtmf-key">
          {k}
        </button>
      ))}
    </div>
  );
}
