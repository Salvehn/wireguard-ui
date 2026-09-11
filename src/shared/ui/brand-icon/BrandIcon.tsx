export function BrandIcon({ size = 46 }: { size?: number }) {
  return (
    <img
      src="./wireguard.svg"
      width={size}
      height={size}
      alt="WireGuard"
      className="wg-icon"
    />
  );
}
