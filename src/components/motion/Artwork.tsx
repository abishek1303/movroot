export function FolderGlyph() {
  return (
    <>
      <path
        className="motion-folder-back"
        d="M-27 15v-30a5 5 0 0 1 5-5h15l6 6h22a5 5 0 0 1 5 5v24a5 5 0 0 1-5 5h-43a5 5 0 0 1-5-5Z"
      />
      <path
        className="motion-folder-front"
        d="M-27 1a4 4 0 0 1 4-4h46a4 4 0 0 1 4 4v14a5 5 0 0 1-5 5h-44a5 5 0 0 1-5-5Z"
      />
    </>
  );
}

export function FileGlyph() {
  return (
    <>
      <path
        className="motion-file"
        d="M-9-13H4l5 5v19a2 2 0 0 1-2 2H-7a2 2 0 0 1-2-2Z"
      />
      <path d="M4-13v5h5M-4-2h8m-8 5h8" />
    </>
  );
}
