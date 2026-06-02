import { useEffect, useRef, useState } from "react";

/**
 * Interactive QR preview. Uses qr-code-styling client-side for live re-render
 * and brand-styling support (logo center, accent colour). Returns an SVG
 * string + PNG bytes via the onReady callback so the builder can hand them
 * directly to the API as `precomputed`.
 */
export interface QrPreviewProps {
  data: string;
  size?: number;
  /** ECC level — use "H" if you intend to put a logo in the centre. */
  level?: "L" | "M" | "Q" | "H";
  logoUrl?: string;
  accentColor?: string;
  onReady?: (out: { svg: string; pngBase64: string }) => void;
}

export function QrPreview(props: QrPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!props.data) return;
    // Dynamic import so the library never runs during SSR (we're SPA-only, but
    // it also keeps the initial bundle smaller).
    import("qr-code-styling")
      .then(async ({ default: QRCodeStyling }) => {
        if (cancelled || !containerRef.current) return;

        // Recreate on each input change — simpler than diffing and the
        // library is fast enough.
        containerRef.current.innerHTML = "";
        const instance = new QRCodeStyling({
          width: props.size ?? 256,
          height: props.size ?? 256,
          type: "svg",
          data: props.data,
          ...(props.logoUrl ? { image: props.logoUrl } : {}),
          qrOptions: { errorCorrectionLevel: props.level ?? "H" },
          dotsOptions: {
            color: "#000000",
            type: "square",
          },
          backgroundOptions: { color: "#ffffff" },
          cornersSquareOptions: {
            color: props.accentColor ?? "#000000",
            type: "extra-rounded",
          },
          cornersDotOptions: {
            color: props.accentColor ?? "#000000",
          },
          imageOptions: {
            crossOrigin: "anonymous",
            margin: 6,
            imageSize: 0.28,
            saveAsBlob: true,
          },
        });
        instance.append(containerRef.current);
        instanceRef.current = instance;

        try {
          const svgBlob = await instance.getRawData("svg");
          const pngBlob = await instance.getRawData("png");
          if (!svgBlob || !pngBlob || cancelled) return;
          const svgText = await blobToText(svgBlob as Blob);
          const pngB64 = await blobToBase64(pngBlob as Blob);
          props.onReady?.({ svg: svgText, pngBase64: pngB64 });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e) => setError(String(e)));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.data, props.size, props.level, props.logoUrl, props.accentColor]);

  return (
    <div>
      <div className="qr" ref={containerRef} />
      {error && <div className="alert error">{error}</div>}
    </div>
  );
}

async function blobToText(blob: Blob): Promise<string> {
  return await blob.text();
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
