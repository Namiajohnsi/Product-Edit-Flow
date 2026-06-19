import PropTypes from "prop-types";
export default function ProductEditHeader({
  title,
  isDirty,
  isSaving,
  onSave,
  onDiscard,
}) {
  return (
    <div style={styles.header}>
      <h1 style={styles.title}>{title}</h1>

      <div style={styles.headerActions}>
        <button
          style={isDirty ? styles.discardButton : styles.discardButtonDisabled}
          disabled={!isDirty}
          onClick={onDiscard}
        >
          Discard
        </button>

        <button
          style={isSaving || !isDirty ? styles.buttonDisabled : styles.button}
          disabled={isSaving || !isDirty}
          onClick={onSave}
        >
          {isSaving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

const styles = {
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
    background: "#ffffffe3",
    padding: "16px 20px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
  },
  headerActions: {
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    margin: 0,
    color: "#1a202c",
  },
  button: {
    background: "#038a6adc",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "10px 24px",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
  buttonDisabled: {
    background: "#b2dfdb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "10px 24px",
    cursor: "not-allowed",
    fontSize: 14,
    fontWeight: 600,
  },
  discardButton: {
    background: "#fff",
    color: "#444",
    border: "1px solid #ccc",
    borderRadius: 6,
    padding: "10px 24px",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
  discardButtonDisabled: {
    background: "#fff",
    color: "#9b9b9b",
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    padding: "10px 24px",
    cursor: "not-allowed",
    fontSize: 14,
    fontWeight: 600,
  },
};

ProductEditHeader.propTypes = {
  title: PropTypes.string.isRequired,
  isDirty: PropTypes.bool.isRequired,
  isSaving: PropTypes.bool.isRequired,
  onSave: PropTypes.func.isRequired,
  onDiscard: PropTypes.func.isRequired,
};