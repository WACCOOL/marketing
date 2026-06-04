import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AppImageMode, FixtureMount, Product } from "@wac/shared";
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
import { removeBackground } from "../lib/cutout.js";
import {
  autoPlaceForMount,
  expandArray,
  hasUsableDimension,
  looksOpaque,
  newFixtureFromProduct,
  seedSceneWidthMm,
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
  const [aiRelight, setAiRelight] = useState(false);
  const [lightsOn, setLightsOn] = useState(false);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [outputFormat, setOutputFormat] = useState<"png" | "jpeg">("png");
  const [name, setName] = useState("");
  const [roomType, setRoomType] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  // Source image URLs currently having their background removed.
  const [mattingUrls, setMattingUrls] = useState<Set<string>>(new Set());
  const [matteError, setMatteError] = useState<string | null>(null);

  const isComposite = mode === "composite" || mode === "hybrid";

  const pxPerMm = useMemo(
    () =>
      scene ? pxPerMmFromSceneWidth(scene.naturalWidth, sceneWidthMm) : null,
    [scene, sceneWidthMm],
  );

  // The "hero" fixture drives fixture-aware scene gen + auto-placement: the
  // selected one, else the first placed.
  const hero = fixtures.find((f) => f.id === selectedId) ?? fixtures[0] ?? null;

  /** Seed a sane starting scale from the hero fixture for generated scenes. */
  function maybeSeedScale(next: SceneSelection | null, heroFixture: FixtureDraft | null) {
    if (!next?.generated || !heroFixture) return;
    const mm = seedSceneWidthMm(heroFixture);
    if (mm) setSceneWidthMm(mm);
  }

  function handleSceneChange(next: SceneSelection | null) {
    setScene(next);
    maybeSeedScale(next, hero);
  }

  function addFixture(product: Product) {
    const draft = newFixtureFromProduct(product);
    setFixtures((prev) => [...prev, draft]);
    setSelectedId(draft.id);
    setPickerOpen(false);
    // First fixture dropped onto a generated scene: seed a starting scale.
    if (fixtures.length === 0) maybeSeedScale(scene, draft);
    // Remove the background up front so placement shows the real cutout.
    if (draft.sourceImageUrl) void runMatte(draft.sourceImageUrl);
  }

  /**
   * Remove a source image's background and store the transparent PNG as the
   * cutout for every fixture using that image. Cached server-side, so picking
   * the same image again (or an array copy) is instant.
   */
  async function runMatte(sourceUrl: string) {
    setMatteError(null);
    setMattingUrls((prev) => new Set(prev).add(sourceUrl));
    try {
      const { url } = await removeBackground(sourceUrl);
      setFixtures((prev) =>
        prev.map((f) =>
          f.sourceImageUrl === sourceUrl ? { ...f, cutoutUrl: url } : f,
        ),
      );
    } catch (e) {
      setMatteError(
        e instanceof Error ? e.message : "Background removal failed.",
      );
    } finally {
      setMattingUrls((prev) => {
        const next = new Set(prev);
        next.delete(sourceUrl);
        return next;
      });
    }
  }

  /** Switch the selected fixture's source image and re-run background removal. */
  function changeFixtureImage(id: string, sourceUrl: string) {
    changeFixture(id, { sourceImageUrl: sourceUrl, cutoutUrl: "" });
    void runMatte(sourceUrl);
  }

  /** Override the hero fixture's mount and re-run its auto-placement. */
  function changeMount(mount: FixtureMount) {
    if (!hero) return;
    changeFixture(hero.id, { mount, ...autoPlaceForMount(mount) });
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
        aiRelight: aiRelight || lightsOn,
        lightsOn,
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
          dimensions. Pick a fixture, set the scene, place and adjust it, then
          generate and save to the library.
        </div>
      </div>

      {isComposite && (
        <>
          <Step n={1} title="Choose your fixture(s)">
            <div className="card col" style={{ gap: 12 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="muted">
                  {fixtures.length === 0
                    ? "Start by picking the hero fixture you want to showcase."
                    : `${fixtures.length} added. The selected one drives the scene + auto-placement.`}
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

              {hero && (
                <FixtureImagePicker
                  fixture={hero}
                  matting={mattingUrls.has(hero.sourceImageUrl)}
                  error={matteError}
                  onPick={(url) => changeFixtureImage(hero.id, url)}
                  onRetry={() => runMatte(hero.sourceImageUrl)}
                />
              )}
            </div>
          </Step>

          <Step n={2} title="Set the scene">
            <SceneInput
              scene={scene}
              sceneWidthMm={sceneWidthMm}
              onSceneChange={handleSceneChange}
              onWidthMmChange={setSceneWidthMm}
              fixtureType={hero?.fixtureType}
              mount={hero?.mount}
              onMountChange={changeMount}
            />
          </Step>

          {scene && (
            <Step n={3} title="Place, scale & adjust perspective">
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
            </Step>
          )}
        </>
      )}

      <Step
        n={isComposite ? 4 : 1}
        title={isComposite ? "Finishing & output" : "Concept generation"}
      >
        <ModePicker
          mode={mode}
          onModeChange={setMode}
          prompt={prompt}
          onPromptChange={setPrompt}
          harmonizeStrength={harmonizeStrength}
          onHarmonizeStrengthChange={setHarmonizeStrength}
          harmonizeShadowPx={harmonizeShadowPx}
          onHarmonizeShadowPxChange={setHarmonizeShadowPx}
          aiRelight={aiRelight}
          onAiRelightChange={setAiRelight}
          lightsOn={lightsOn}
          onLightsOnChange={setLightsOn}
          referenceImages={referenceImages}
          onReferenceImagesChange={setReferenceImages}
          outputFormat={outputFormat}
          onOutputFormatChange={setOutputFormat}
        />
      </Step>

      <Step n={isComposite ? 5 : 2} title="Generate & save">
        <GenerationPreview
          name={name}
          onNameChange={setName}
          roomType={roomType}
          onRoomTypeChange={setRoomType}
          buildRequest={buildRequest}
        />
      </Step>

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

/**
 * Image chooser for the hero fixture, shown in the fixture step. Picking an
 * option removes its background server-side and previews the transparent cutout
 * (with a spinner while it processes), so placement uses the finished cutout.
 */
function FixtureImagePicker({
  fixture,
  matting,
  error,
  onPick,
  onRetry,
}: {
  fixture: FixtureDraft;
  matting: boolean;
  error: string | null;
  onPick: (url: string) => void;
  onRetry: () => void;
}) {
  const ready = Boolean(fixture.cutoutUrl) && !matting;
  return (
    <div className="col" style={{ gap: 10, marginTop: 4 }}>
      <label>Product image — background is removed automatically</label>
      <div className="row" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="fixture-cutout-preview">
          {matting ? (
            <div className="muted" style={{ textAlign: "center" }}>
              <div className="spinner" />
              Removing background…
            </div>
          ) : fixture.cutoutUrl ? (
            <img src={fixture.cutoutUrl} alt={`${fixture.name} cutout`} />
          ) : (
            <div className="muted" style={{ textAlign: "center", padding: 8 }}>
              {error ? "Couldn't remove background" : "No image"}
            </div>
          )}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 8, flex: 1 }}>
          {fixture.imageOptions.map((url) => (
            <button
              key={url}
              type="button"
              className={
                "cutout-option" +
                (url === fixture.sourceImageUrl ? " selected" : "")
              }
              onClick={() => onPick(url)}
              disabled={matting}
              title={looksOpaque(url) ? "Background will be removed" : url}
            >
              <img src={url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </div>
      {error && !matting ? (
        <div className="alert alert-error">
          {error}{" "}
          <button className="link-button" type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {!ready && !matting && !error ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Pick the product image you want to place.
        </div>
      ) : null}
    </div>
  );
}

/** A numbered step wrapper for the guided generation flow. */
function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <span className="step-badge">{n}</span>
        <h3 style={{ margin: 0 }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}
