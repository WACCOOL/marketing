import type * as React from "react";
import type { ModelViewerElement } from "@google/model-viewer";

/**
 * JSX typing for Google's <model-viewer> custom element (the 3D-viewer placement
 * path). Only the attributes we use are declared; the element instance is typed
 * as ModelViewerElement so refs expose getCameraOrbit()/getFieldOfView().
 */
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<ModelViewerElement> & {
          src?: string;
          alt?: string;
          poster?: string;
          "camera-orbit"?: string;
          "field-of-view"?: string;
          "camera-controls"?: boolean | "";
          "disable-zoom"?: boolean | "";
          "disable-pan"?: boolean | "";
          "disable-tap"?: boolean | "";
          "interaction-prompt"?: string;
          "tone-mapping"?: string;
          "shadow-intensity"?: string | number;
          exposure?: string | number;
          "environment-image"?: string;
          "min-camera-orbit"?: string;
          "max-camera-orbit"?: string;
          "min-field-of-view"?: string;
          "max-field-of-view"?: string;
        },
        ModelViewerElement
      >;
    }
  }
}

export {};
