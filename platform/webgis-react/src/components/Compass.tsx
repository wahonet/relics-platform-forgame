interface CompassProps {
  rotation: number;
  scale?: string;
}

export function Compass({ rotation, scale }: CompassProps) {
  return (
    <>
      <div className="compass">
        <div className="compass-ring" style={{ transform: `rotate(${rotation}deg)` }}>
          N
        </div>
      </div>
      {scale ? <div className="scale-bar">{scale}</div> : null}
    </>
  );
}
