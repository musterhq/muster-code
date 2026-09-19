import React, {useEffect, useState} from 'react';
import {ZoomIn, ZoomOut} from 'lucide-react';
import type {Commands} from '../../shared/protocol';

export function ImageFile({asset,name}: {asset: Commands['files.asset']['output']; name: string}) {
  const [zoom,setZoom] = useState<number | null>(null);
  const [error,setError] = useState(false);
  const [loaded,setLoaded] = useState(false);
  useEffect(() => {setError(false); setLoaded(false);}, [asset.dataUrl]);
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
      <img src={asset.dataUrl} alt={name} decoding="async" onLoad={() => setLoaded(true)} onError={() => setError(true)} style={zoom === null ? {} : {width:asset.width*zoom,height:asset.height*zoom}}/>
    </div>}
    <div className="image-file-meta">{asset.width} × {asset.height} pixels · {(asset.size/1024).toFixed(1)} KiB · {asset.mime}</div>
  </div>;
}
