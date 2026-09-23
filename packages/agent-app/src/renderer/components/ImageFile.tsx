import React, {useEffect, useRef, useState} from 'react';
import {releaseImage, usePageVisible} from '../pageVisibility';
import {ZoomIn, ZoomOut} from 'lucide-react';
import type {Commands} from '../../shared/protocol';

export function ImageFile({asset,name}: {asset: Commands['files.asset']['output']; name: string}) {
  const [zoom,setZoom] = useState<number | null>(null);
  const [error,setError] = useState(false);
  const [loaded,setLoaded] = useState(false);
  // SVG may declare no intrinsic size; the decoded <img> reports it. <img> never runs SVG scripts.
  const [natural,setNatural] = useState<{width:number;height:number} | null>(null);
  useEffect(() => {setError(false); setLoaded(false); setNatural(null);}, [asset.dataUrl]);
  // PER-04: while the window is hidden the decoded bitmap is released; it decodes again on return.
  const visible = usePageVisible(), image = useRef<HTMLImageElement>(null);
  useEffect(() => {if (!visible) {releaseImage(image.current); setLoaded(false);}}, [visible]);
  useEffect(() => { const element = image.current; return () => releaseImage(element); }, []);
  const width = asset.width || natural?.width || 0, height = asset.height || natural?.height || 0;
  return <div className="image-file">
    <div className="image-file-toolbar" role="group" aria-label="Image view">
      <button aria-pressed={zoom === null} onClick={() => setZoom(null)}>Fit</button>
      <button aria-pressed={zoom === 1} onClick={() => setZoom(1)}>Actual size</button>
      <button className="icon-button" aria-label="Zoom out" disabled={zoom !== null && zoom <= .25} onClick={() => setZoom(value => Math.max(.25,(value ?? 1)/2))}><ZoomOut size={14}/></button>
      <span>{zoom === null ? 'Fit' : `${zoom*100}%`}</span>
      <button className="icon-button" aria-label="Zoom in" disabled={zoom !== null && zoom >= 4} onClick={() => setZoom(value => Math.min(4,(value ?? 1)*2))}><ZoomIn size={14}/></button>
    </div>
    {error ? <div className="pane-error" role="status">The image decoder could not display this file. Its header is recognized, but its image data may be damaged.</div> : <div className="image-file-canvas" data-fit={zoom === null}>
      {!loaded && <span className="image-loading" role="status">Decoding image…</span>}
      <img ref={image} src={visible ? asset.dataUrl : undefined} alt={name} decoding="async" onLoad={event => {setLoaded(true); const image = event.currentTarget; if (image.naturalWidth) setNatural({width: image.naturalWidth, height: image.naturalHeight});}} onError={() => setError(true)} style={zoom === null || !width ? {} : {width:width*zoom,height:height*zoom}}/>
    </div>}
    <div className="image-file-meta">{width ? `${width} × ${height} pixels · ` : ''}{(asset.size/1024).toFixed(1)} KiB · {asset.mime}</div>
  </div>;
}
