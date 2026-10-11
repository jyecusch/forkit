// Package graph lays out commit history as lanes and serves windows of rows,
// so the frontend never needs more than what is on screen.
package graph

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"

	"github.com/jyecusch/forkit/internal/model"
)

// History is the commit DAG in display order. Commits are identified by an
// id assigned the first time their oid is seen (as a commit or as a parent),
// so parent links are plain integers rather than hashes.
type History struct {
	oidLen      int
	oids        []byte  // oidLen bytes per id
	slots       []int32 // open-addressing index from oid to id; 0 is empty, otherwise id+1
	idRow       []int32 // row of each id, -1 until its commit line is read
	rowID       []int32
	parentStart []int32 // parents of row r are parentIDs[parentStart[r]:parentStart[r+1]]
	parentIDs   []int32
}

func newHistory() *History {
	return &History{slots: make([]int32, 1024), parentStart: []int32{0}}
}

// Len is the number of commits (rows).
func (h *History) Len() int { return len(h.rowID) }

// Append adds the next commit in display order. Every commit must come before
// its parents, as git log --topo-order and --date-order guarantee.
func (h *History) Append(oid []byte, parents [][]byte) error {
	id, err := h.intern(oid)
	if err != nil {
		return err
	}
	if h.idRow[id] >= 0 {
		return fmt.Errorf("commit %x listed twice", oid)
	}
	row := int32(len(h.rowID))
	h.idRow[id] = row
	h.rowID = append(h.rowID, id)
	for _, parent := range parents {
		parentID, err := h.intern(parent)
		if err != nil {
			return err
		}
		h.parentIDs = append(h.parentIDs, parentID)
	}
	h.parentStart = append(h.parentStart, int32(len(h.parentIDs)))
	return nil
}

// Prepend returns a history with newer commits placed above h's. It is valid
// only when none of h's commits has a parent among newer, which holds when
// newer was read with h's tips excluded.
func (h *History) Prepend(newer *History) (*History, error) {
	merged := newHistory()
	for _, source := range []*History{newer, h} {
		for row := range source.Len() {
			parents := source.Parents(row)
			parentOIDs := make([][]byte, len(parents))
			for i, parent := range parents {
				parentOIDs[i] = source.oidOf(parent)
			}
			if err := merged.Append(source.oidOf(source.rowID[row]), parentOIDs); err != nil {
				return nil, err
			}
		}
	}
	return merged, nil
}

// Parents returns the ids of row's parents, first parent first.
func (h *History) Parents(row int) []int32 {
	return h.parentIDs[h.parentStart[row]:h.parentStart[row+1]]
}

// RowOfID returns the row of a commit id, or -1 if it has not been read.
func (h *History) RowOfID(id int32) int32 { return h.idRow[id] }

// RowOf returns the row of a commit, or -1 if it is not in the history.
func (h *History) RowOf(oid model.OID) int32 {
	raw, err := hex.DecodeString(string(oid))
	if err != nil || len(raw) != h.oidLen {
		return -1
	}
	id, ok := h.lookup(raw)
	if !ok {
		return -1
	}
	return h.idRow[id]
}

// OID returns the hash of the commit at row.
func (h *History) OID(row int) model.OID {
	return model.OID(hex.EncodeToString(h.oidOf(h.rowID[row])))
}

func (h *History) oidOf(id int32) []byte {
	return h.oids[int(id)*h.oidLen : int(id+1)*h.oidLen]
}

func (h *History) intern(oid []byte) (int32, error) {
	if h.oidLen == 0 {
		h.oidLen = len(oid)
	}
	if len(oid) != h.oidLen {
		return 0, fmt.Errorf("oid %x has %d bytes, expected %d", oid, len(oid), h.oidLen)
	}
	if id, ok := h.lookup(oid); ok {
		return id, nil
	}
	if (len(h.idRow)+1)*2 > len(h.slots) {
		h.grow()
	}
	id := int32(len(h.idRow))
	h.oids = append(h.oids, oid...)
	h.idRow = append(h.idRow, -1)
	h.insertSlot(oid, id)
	return id, nil
}

func (h *History) lookup(oid []byte) (int32, bool) {
	mask := uint64(len(h.slots) - 1)
	for i := slotHash(oid) & mask; ; i = (i + 1) & mask {
		slot := h.slots[i]
		if slot == 0 {
			return 0, false
		}
		if id := slot - 1; string(h.oidOf(id)) == string(oid) {
			return id, true
		}
	}
}

func (h *History) insertSlot(oid []byte, id int32) {
	mask := uint64(len(h.slots) - 1)
	i := slotHash(oid) & mask
	for h.slots[i] != 0 {
		i = (i + 1) & mask
	}
	h.slots[i] = id + 1
}

func (h *History) grow() {
	h.slots = make([]int32, len(h.slots)*2)
	for id := range int32(len(h.idRow)) {
		h.insertSlot(h.oidOf(id), id)
	}
}

// slotHash uses the oid's leading bytes, which are already uniformly
// distributed.
func slotHash(oid []byte) uint64 {
	return binary.LittleEndian.Uint64(oid)
}
