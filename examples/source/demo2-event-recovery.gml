; GMLisp demo skeleton 2
; Purpose: intervention and recovery behavior (base + delta)

(score :id :demo2-event-recovery
  :title "Demo 2 Event Recovery"
  :author "okamura"

  (part :tense
    :loop true
    :ch [:fm1 :fm2]

    (phrase :bed
      :tempo 132
      :len 1/16

      (marker :calm)
      (note :a3)
      (tie 1/16)
      (rest 1/16)
      (note :c4)

      (param-set :fm-tl1 40)
      (param-set :tempo-scale 0)

      (loop-begin :stress)
      (param-add :fm-tl1 -3)
      (param-add :tempo-scale +2)
      (note :e4)
      (note :d4)
      (rest 1/16)
      (param-add :fm-tl1 +2)
      (param-add :tempo-scale -2)
      (loop-end :stress 8)

      (marker :recover)
      (rest 1/4)
      (jump :calm))))
