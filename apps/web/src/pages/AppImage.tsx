import { useMemo, useState } from "react";
import type { AppImageMode, Product } from "@wac/shared";
import { APPIMAGE_PARAMS_VERSION } from "@wac/shared";
import { ProductPicker } from "../components/ProductPicker.js";
import { SceneInput, type SceneSelection } from "../components/SceneInput.js";
import { PlacementCanvas } from "../components/PlacementCanvas.js";
import { ModePicker } from "../components/ModePicker.js";
import {
  GenerationPreview,
  type JobRequest,
} from "../components/GenerationPreview.js";
import { pxPerMmFromSceneWidth } from "../lib/appimageScale.js";
import {
  expandArray,
  hasUsableDimension,
  newFixtureFromProduct,
  type FixtureDraft,
} from "../lib/appimageDraft.js";

/**
 * Application Image Generator (Phase 2e). Pick fixtures, drop them into an
 * uploaded scene at a computed scale, adjust placement, choose a mode
 * (composite / hybrid / concept), then generate → preview → save. Assembles the
 * canonical AppImageParams and submits via the async job pipeline.
 */
export function AppImage() {
  const [mode, setMode] = useState<AppImageMode>("hybrid");
  const [scene, setScene] = useState<SceneSelection | null>(null);
  const [sceneWidthMm, setSceneWidthMm] = useState(3048);
  const [scaleAdjust, setScaleAdjust] = useState(1);
  const [fixtures, setFixtures] = useState<FixtureDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [harmonizeStrength, setHarmonizeStrength] = useState(0.7);
  const [harmonizeShadowPx, setHarmonizeShadowPx] = useState(0);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [outputFormat, setOutputFormat] = useState<"png" | "jpeg">("png");
  const [name, setName] = useState("");
  const [roomType, setRoomType] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const isComposite = mode === "composite" || mode === "hybrid";

  const pxPerMm = useMemo(
    () =>
      scene ? pxPerMmFromSceneWidth(scene.naturalWidth, sceneWidthMm) : null,
    [scene, sceneWidthMm],
  );

  function addFixture(product: Product) {
    const draft = newFixtureFromProduct(product);
    setFixtures((prev) => [...prev, draft]);
    setSelectedId(draft.id);
    setPickerOpen(false);
  }

  function changeFixture(id: string, patch: Partial<FixtureDraft>) {
    setFixtures((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );
  }

  function removeFixture(id: string) {
    setFixtures((prev) => prev.filter((f) => f.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  function addArray(baseId: string, count: number, spacingPct: number) {
    setFixtures((prev) => {
      const base = prev.find((f) => f.id === baseId);
      if (!base) return prev;
      const expanded = expandArray(base, count, spacingPct);
      const out = prev.flatMap((f) => (f.id === baseId ? expanded : [f]));
      return out;
    });
  }

  function buildRequest(): JobRequest | { error: string } {
    const params: Record<string, unknown> = {
      version: APPIMAGE_PARAMS_VERSION,
      mode,
      output: { format: outputFormat },
    };

    const tags = new Set<string>();
    if (roomType.trim()) tags.add(`room:${roomType.trim().toLowerCase()}`);

    if (mode === "concept") {
      if (!prompt.trim()) return { error: "Concept mode needs a prompt." };
      params.prompt = prompt.trim();
      params.referenceImages = referenceImages;
      return { params, tags: [...tags] };
    }

    // composite | hybrid
    if (!scene) return { error: "Upload a scene image first." };
    if (!pxPerMm) {
      return { error: "Set the scene's real-world width to compute scale." };
    }
    if (fixtures.length === 0) return { error: "Add at least one fixture." };
    for (const f of fixtures) {
      if (!f.cutoutUrl) {
        return { error: `Fixture ${f.sku} has no cutout image selected.` };
      }
      if (!hasUsableDimension(f.dimensionsMm)) {
        return {
          error: `Fixture ${f.sku} has no usable dimensions (width/height/diameter/length).`,
        };
      }
      tags.add(`sku:${f.sku}`);
    }

    params.sceneUrl = scene.url;
    params.scale = { pxPerMm, scaleAdjust };
    params.fixtures = fixtures.map((f) => ({
      cutoutUrl: f.cutoutUrl,
      dimensionsMm: f.dimensionsMm,
      anchor: f.anchor,
      xPct: f.xPct,
      yPct: f.yPct,
      widthBasis: f.widthBasis,
      ...(f.perspective ? { perspective: f.perspective } : {}),
    }));
    if (mode === "hybrid") {
      if (prompt.trim()) params.prompt = prompt.trim();
      params.harmonize = {
        enabled: true,
        strength: harmonizeStrength,
        shadowPx: harmonizeShadowPx,
      };
    }

    return { params, tags: [...tags] };
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Image Generator</h2>
        <div className="muted">
          Place real WAC fixtures into a room, sized to scale from Sales Layer
          dimensions. Choose a mode, drop fixtures onto your scene, then generate
          and save to the library.
        </div>
      </div>

      <ModePicker
        mode={mode}
        onModeChange={setMode}
        prompt={prompt}
        onPromptChange={setPrompt}
        harmonizeStrength={harmonizeStrength}
        onHarmonizeStrengthChange={setHarmonizeStrength}
        harmonizeShadowPx={harmonizeShadowPx}
        onHarmonizeShadowPxChange={setHarmonizeShadowPx}
        referenceImages={referenceImages}
        onReferenceImagesChange={setReferenceImages}
        outputFormat={outputFormat}
        onOutputFormatChange={setOutputFormat}
      />

      {isComposite && (
        <>
          <SceneInput
            scene={scene}
            sceneWidthMm={sceneWidthMm}
            onSceneChange={setScene}
            onWidthMmChange={setSceneWidthMm}
          />

          <div className="card col" style={{ gap: 12 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <h3 style={{ margin: 0 }}>Fixtures</h3>
                <div className="muted">
                  {fixtures.length} placed. Add fixtures and arrange them on the
                  scene.
                </div>
              </div>
              <button onClick={() => setPickerOpen(true)}>Add fixture</button>
            </div>
            {fixtures.length > 0 && (
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {fixtures.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={
                      "tag" + (f.id === selectedId ? " tag-selected" : "")
                    }
                    onClick={() => setSelectedId(f.id)}
                  >
                    {f.sku}
                  </button>
                ))}
              </div>
            )}
          </div>

          {scene && (
            <PlacementCanvas
              scene={scene}
              pxPerMm={pxPerMm}
              scaleAdjust={scaleAdjust}
              onScaleAdjustChange={setScaleAdjust}
              fixtures={fixtures}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChangeFixture={changeFixture}
              onRemoveFixture={removeFixture}
              onAddArray={addArray}
            />
          )}
        </>
      )}

      <GenerationPreview
        name={name}
        onNameChange={setName}
        roomType={roomType}
        onRoomTypeChange={setRoomType}
        buildRequest={buildRequest}
      />

      {pickerOpen && (
        <div className="modal-overlay" onClick={() => setPickerOpen(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>Pick a fixture</h3>
              <button
                className="secondary"
                onClick={() => setPickerOpen(false)}
              >
                Close
              </button>
            </div>
            <ProductPicker onSelect={addFixture} />
          </div>
        </div>
      )}
    </div>
  );
}
